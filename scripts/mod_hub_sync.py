
#!/usr/bin/env python3
"""Mod Hub upstream sync: keep the Aslain-ingested catalog current.

Where "mod_hub_publish.py" is the maintainer's manual ingest pipeline, this
module is the one entry point the scheduled workflow
(".github/workflows/mod-hub-sync.yml") calls to reconcile the LIVE catalog
(Discussions threads + release assets) against Aslain's current Configuration:

    python scripts/mod_hub_sync.py detect                  # read-only diff + report
    python scripts/mod_hub_sync.py apply                   # the real sync
    python scripts/mod_hub_sync.py apply --dry-run         # plan without any write
    python scripts/mod_hub_sync.py apply --include-new     # also publish new entries
    python scripts/mod_hub_sync.py apply --no-gc           # skip asset pruning
    python scripts/mod_hub_sync.py apply --reaudit         # one-shot content re-audit of the whole live scope
    python scripts/mod_hub_sync.py index-only              # re-crawl + republish index
    python scripts/mod_hub_sync.py render-summary --json r.json
    python scripts/mod_hub_sync.py selftest                # offline checks

Design invariants (docs/en/designs/mod-hub.md, "Upstream sync automation"):

- Content-addressed assets. A package's release asset is named after its
  content fingerprint: "pkg-<md5 8>.zip" (Aslain embeds the first 8 hex of the
  package md5 in its filename) or "pkg7-<sha256 12>.zip" for the tokenless
  absolute-URL 7z outliers. Identical packages shared by many entries dedupe
  onto one asset. Because the fingerprint lives in the asset name, the
  published threads themselves are the sync state: change detection compares
  the Configuration against the download lines already in each thread, so a
  fresh checkout needs no persisted snapshot. The first run migrates the
  legacy "<slug>[-partN].zip" naming wholesale.
- Per-entry version semantics. An entry's "version" only moves when its
  package bytes actually changed (the app compares versions as strings to
  decide "update available"). Game-range refreshes rewrite the front matter
  without bumping the version, so a game patch never prompts a mass
  re-download. Game minor bumps are followed automatically (maintainer
  decision 2026-10-26).
- Two-phase removals. An entry that vanished upstream, was disabled there, or
  moved out of the ingested scope gets its thread marked "sync source closed"
  (hidden wowsp:sync-stale block + a visible notice) and STAYS installable;
  delisting (closing the thread) remains a human decision, flagged in the
  run report (the workflow job summary) for review.
- Proposal-gated additions. New upstream entries only appear in the report
  until their slug tables are curated; "--include-new" publishes exactly the
  slugs resolved through scripts/mod_hub_slugs.py.
- Safety gates. zip magic/repack validation, a content-based package-set
  audit before staging (raw OlliN ShipIdentity template exclusion, plus
  legacy-conflicting duplicate-target reporting, see audit_package_set),
  package-content checks (.swf member magic + glue-reference scan,
  mod_package_check),
  digest-idempotent asset uploads,
  an asset-existence gate on the index (>25% missing refuses the upload,
  delisted/stale entries exempt), a post-publish read-back verification with
  rollback to the previous index bytes, and >=1s spacing between Discussion
  mutations (GitHub's 80/min content-generation limit).
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import hashlib
import io
import json
import posixpath
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

# Sibling modules (same directory -- sys.path[0] when run as a script).
import mod_hub_publish as pub  # noqa: E402 - repo-local
import mod_index  # noqa: E402 - repo-local
import mod_package_check  # noqa: E402 - repo-local
import mod_package_hygiene  # noqa: E402 - repo-local
from mod_hub_slugs import SLUG_MAP  # noqa: E402 - repo-local

REPO = pub.REPO
RELEASE_TAG = pub.RELEASE_TAG
ROOT_URL = pub.ROOT_URL
RELEASE_URL_BASE = f"https://github.com/{REPO}/releases/download/{RELEASE_TAG}"
# "Show and tell", the category every mod thread lives in (same as pub.discussions).
SHOW_AND_TELL_CATEGORY = "DIC_kwDOTZ4Crs4DERxL"

# An Aslain catalog id always carries its category prefix (Team_Panel_..., UI_...);
# hand-published threads never do.
ASLAIN_ID_RE = re.compile(r"^(Team_Panel|Team_Mini_Panel|Minimap|Chat|UI|Markers|Port_mods|texts)_")
# Aslain <Implicit> packages WoWSP must never re-ship. Aslain's own manager
# post-processes some shared files at install time per the user's component
# selection; re-distributing them raw ships the un-substituted template.
# Concretely ShipIdentity.unbound is OlliN's merged port-UI payload whose
# "*_INSTALLED" component switches are resolved by Aslain's installer -- and
# with every OlliN art component excluded from this catalog the raw file is
# dead weight that also breaks port ship-name rendering for new collab ships
# (Blue-Archive PJSS820 rendered a blank name, 2026-10-31).
#
# This filename match is only the PUBLISH-TIME implicit-name guard: it drops an
# <Implicit> package whose own name says "ShipIdentity". Component-variant
# carriers re-bundle the same template under unrelated names, so the filename
# regex never caught them (the live 2026-11-06/07 assets still carried the raw
# template inside dependent entries). The CONTENT guard -- package_entries() +
# audit_package_set() over every package we are about to publish -- is the
# authoritative one for those variants.
EXCLUDE_IMPLICIT_NAME_RE = re.compile(r"shipidentity", re.IGNORECASE)
# The raw OlliN ShipIdentity template and the directory that holds it. Aslain
# substitutes the per-component "*_INSTALLED" switches at install time; WoWSP
# has no resolution step, so serving the raw template blanks new collab ships'
# port/carousel names (#1634). A package whose whole payload is this template
# is excluded; one that mixes it with functional payload refuses the publish.
SHIP_IDENTITY_TEMPLATE_PATH = "gui/unbound2/!shipidentity/shipidentity.unbound"
SHIP_IDENTITY_TEMPLATE_DIR = "res_mods/gui/unbound2/!shipidentity/"
SHIP_IDENTITY_EXCLUDE_REASON = (
    "raw OlliN ShipIdentity template; Aslain resolves its *_INSTALLED switches "
    "at install time, see #1634"
)
# The md5 prefix Aslain embeds in package filenames (zips only; the absolute-URL
# 7z outliers carry no fingerprint at all).
TOKEN_RE = re.compile(r"_([0-9a-f]{8})\.(?:zip|7z)$", re.IGNORECASE)
CONTENT_ADDR_RE = re.compile(r"^pkg7?-([0-9a-f]{8,12})\.zip$")
# Hidden removal marker this module writes into a thread body.
STALE_BLOCK_RE = re.compile(r"<!--\nwowsp:sync-stale\n(.*?)\nwowsp:sync-stale\n-->", re.DOTALL)

STALE_NOTE = (
    "> **Sync source closed** / 同步来源已关闭：该条目已从 Aslain 上游目录消失、被禁用或移出同步范围。\n"
    "> 人工复核前条目仍可安装；复核确认后关闭本 Discussion 即完成下架。 Upstream source is gone,\n"
    "> disabled or out of scope; the entry stays installable until a maintainer reviews this\n"
    "> thread and closes it (which delists it from the catalog)."
)

GC_MIN_REFERENCED = 50      # a parse bug must never mass-delete a healthy release
GC_MAX_DELETIONS = 150      # per run
GC_MIN_AGE_HOURS = 24       # clients cache the index for up to 6h; keep 4x grace
THREAD_UPDATE_SLEEP = 1.0   # content-generating secondary limit: 80/min
UPLOAD_BATCH = 20
DOWNLOAD_WORKERS = 4

# Per-entry sync policies (scripts/mod_hub_sync_policies.json): "auto"
# (default, full sync), "manual" (selected, but upstream changes are held
# out of the publish until the policy flips back) and "skip" (removed from
# the catalog; threads of skipped entries are never stale-marked).
_POLICIES_PATH = Path(__file__).with_name("mod_hub_sync_policies.json")
POLICY_BY_SLUG: dict = (
    json.loads(_POLICIES_PATH.read_text(encoding="utf-8")).get("policies", {})
    if _POLICIES_PATH.exists() else {}
)


# --------------------------------------------------------------------------- utils


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def game_range(game_version: str) -> str:
    """Derive the compatibility range from Aslain's served game version:
    '15.9.0' -> '>=15.9 <15.10' (replaces curate's hardcoded >=15.7 <15.8)."""
    parts = [p for p in (game_version or "").split(".") if p.isdigit()]
    if not parts:
        return "*"
    major = int(parts[0])
    if len(parts) == 1:
        return f">={major} <{major + 1}"
    minor = int(parts[1])
    return f">={major}.{minor} <{major}.{minor + 1}"


def upstream_token(name: str) -> str | None:
    m = TOKEN_RE.search(name or "")
    return m.group(1).lower() if m else None


def is_content_addressed(name: str) -> bool:
    return bool(CONTENT_ADDR_RE.fullmatch(name or ""))


def download_url(asset: str) -> str:
    return f"{RELEASE_URL_BASE}/{asset}"


# ------------------------------------------------------------------- upstream feed


def collect_selection(cache: Path) -> dict:
    """Fetch root.xml + Configuration + Localizations and build the ingested
    selection (same INCLUDE/EXCLUDE rules as mod_hub_publish.curate) plus the
    whole-catalog id sets the stale classification needs. Disabled upstream
    mods and package-less action-only patches never enter the selection; they
    are recorded so an already-published thread can be stale-marked instead."""
    root = ET.fromstring(pub.fetch_binary(ROOT_URL, cache / "root.xml").read_bytes())
    caches = {
        c.attrib["Version"]: c.attrib["Url"]
        for c in root.iter("Cache")
        if c.attrib.get("Version") and c.attrib.get("Url")
    }
    if not caches:
        sys.exit("root.xml carries no Cache element - nothing to sync")
    game_version = max(caches, key=lambda v: [int(x) for x in v.split(".") if x.isdigit()])
    base_url = caches[game_version]
    bin_max = (root.findtext("MaxGameBin") or "").strip()

    cfg = ET.fromstring(
        pub.fetch_binary(f"{base_url}/Configuration", cache / "Configuration").read_bytes())
    loc_root = ET.fromstring(
        pub.fetch_binary(f"{base_url}/Localizations", cache / "Localizations").read_bytes())
    locs: dict = {}
    for item in loc_root.iter("Item"):
        entry: dict = {}
        for loc in item.iter("Loc"):
            entry[loc.attrib.get("Lang", "")] = dict(loc.attrib)
        locs[item.attrib["Id"]] = entry

    content_version = cfg.attrib.get("ContentVersion", "")
    version = pub.catalog_version(content_version)
    game = game_range(game_version)

    mods: list[dict] = []
    catalog_ids: set = set()
    disabled_ids: dict = {}
    out_of_scope_ids: set = set()
    for cat in cfg.iter("Category"):
        cid = cat.attrib.get("Id", "")
        for mod in cat.iter("Mod"):
            mid = mod.attrib.get("Id", "")
            if not mid:
                continue
            catalog_ids.add(mid)
            if mod.attrib.get("Enabled") == "false":
                disabled_ids.setdefault(
                    mid, (mod.attrib.get("DisabledReason") or "disabled upstream").strip())
                continue
            if mod.attrib.get("DisabledReason"):
                disabled_ids.setdefault(mid, mod.attrib["DisabledReason"].strip())
            if cid not in pub.INCLUDE_CATEGORIES or mid in pub.EXCLUDE_MODS:
                out_of_scope_ids.add(mid)
                continue
            pkg_els = mod.findall("Package")
            if mod.attrib.get("File"):
                pkg_els = [mod] + pkg_els  # File= on the Mod itself acts as package #0
            packages = []
            for order, pkg in enumerate(pkg_els):
                file_attr = pkg.attrib.get("File", "") if pkg is not mod else mod.attrib["File"]
                if not file_attr:
                    continue
                name = posixpath.basename(file_attr.replace("\\", "/"))
                packages.append({
                    "url": pub.resolve_url(base_url, file_attr),
                    "name": name,
                    "size_kb": int(pkg.attrib.get("SizeKb", "0") or 0),
                    "order": order,
                    "token": upstream_token(name),
                    "sha256": "",
                    "size_bytes": 0,
                    "asset": "",
                })
            if not packages or all(p["size_kb"] == 0 for p in packages):
                out_of_scope_ids.add(mid)  # action-only patch: nothing to host
                continue
            meta = locs.get(mid, {})
            en = meta.get("en-US", {})
            zh = meta.get("zh-CN", {})
            previews = [pub.resolve_url(base_url, part)
                        for part in (mod.attrib.get("Preview") or "").split("|") if part.strip()]
            loc_meta = {
                lang: {"name": (a.get("Name") or "").strip(),
                       "desc": re.sub(r"\s+", " ", a.get("Description") or "").strip()}
                for lang, a in meta.items()
            }
            mods.append({
                "id": SLUG_MAP.get(pub.slugify(mid), pub.slugify(mid)),
                "aslain_id": mid,
                "category": pub.CATEGORY_RENAME.get(pub.CATEGORY_MAP[cid], pub.CATEGORY_MAP[cid]),
                "version": version,
                "game": game,
                "name_en": en.get("Name") or mid,
                "name_zh": zh.get("Name") or "",
                "description": re.sub(r"\s+", " ", en.get("Description") or "").strip(),
                "author_url": pub.clean_author_url(mod.attrib.get("AuthorUrl", "")),
                "preview_urls": previews,
                "loc_meta": loc_meta,
                "packages": packages,
                "total_kb": sum(p["size_kb"] for p in packages),
            })
    # Shared runtime packages (<Implicit>): Aslain's manager installs these
    # alongside every mod listed in their RequiresAny -- TTaroModUtils (the
    # TTaro framework mods import it on their first line) and the ModForge
    # blueprint engine (ForgeBlueprints-only mods are inert without it).
    # WoWSP bundles them into each dependent's package list so an install is
    # self-contained; the shared-copy uninstall edge is documented on the
    # thread itself.
    implicit: list[dict] = []
    for imp in cfg.iter("Implicit"):
        for pkg in imp.iter("Package"):
            file_attr = pkg.attrib.get("File", "")
            if not file_attr:
                continue
            name = posixpath.basename(file_attr.replace("\\", "/"))
            implicit.append({
                "url": pub.resolve_url(base_url, file_attr),
                "name": name,
                "size_kb": int(pkg.attrib.get("SizeKb", "0") or 0),
                "order": 0,
                "token": upstream_token(name),
                "sha256": "",
                "size_bytes": 0,
                "asset": "",
                "requires_any": [mid for mid
                                 in (pkg.attrib.get("RequiresAny") or "").split("|")
                                 if mid],
            })
    mods.sort(key=lambda m: (m["category"], m["aslain_id"]))
    # Two Aslain ids mapping onto one slug would fight over a single thread;
    # keep the first and say so instead of corrupting the state.
    seen: dict = {}
    deduped = []
    duplicates: list[str] = []
    for m in mods:
        if m["id"] in seen:
            msg = (f"duplicate slug {m['id']}: {seen[m['id']]} and {m['aslain_id']} "
                   "both map to it; keeping the first")
            duplicates.append(msg)
            print(f"  WARN {msg}", file=sys.stderr, flush=True)
            continue
        seen[m["id"]] = m["aslain_id"]
        deduped.append(m)
    print(f"upstream catalog {content_version} (game {game_version}, range {game}, bin {bin_max}): "
          f"{len(deduped)} mods, {sum(m['total_kb'] for m in deduped) / 1024:.1f} MB", flush=True)
    bundled = bundle_implicit_packages(deduped, implicit)
    if bundled:
        print(f"bundled {bundled} shared-runtime package refs into "
              f"{sum(1 for m in deduped if m.get('requires_runtime'))} dependents "
              f"({len(implicit)} implicit packages)", flush=True)
    kept, manual_ids, skipped_ids = apply_policies(deduped)
    if skipped_ids:
        print(f"policy skip: {len(skipped_ids)} entries excluded from the catalog",
              flush=True)
    if manual_ids:
        print(f"policy manual: {len(manual_ids)} entries held for manual approval",
              flush=True)
    return {
        "content_version": content_version,
        "version": version,
        "game_version": game_version,
        "game": game,
        "bin_max": bin_max,
        "mods": kept,
        "catalog_ids": catalog_ids,
        "disabled_ids": disabled_ids,
        "scope_ids": {m["aslain_id"] for m in kept},
        "policy_skipped_ids": skipped_ids,
        "policy_manual_ids": manual_ids,
        "implicit_packages": len(implicit),
        "implicit_bundled": bundled,
        "duplicates": duplicates,
    }


# ------------------------------------------------------------------ live catalog


def parse_stale_block(body: str) -> dict | None:
    m = STALE_BLOCK_RE.search(body or "")
    if not m:
        return None
    info: dict = {}
    for line in m.group(1).splitlines():
        key, _, val = line.partition(":")
        if key.strip():
            info[key.strip()] = val.strip()
    return info or {}


def fetch_thread_state(repo: str) -> list[dict]:
    """One record per wowsp-mod thread, parsed back out of the live body (the
    thread IS the sync state). Merges the crawler's closed/comments nodes with
    the id-bearing crawl so updateDiscussion can address each thread."""
    nodes = mod_index.fetch(repo)
    ids = pub.crawl_thread_ids()  # slug -> {number, id}
    by_number = {v["number"]: v for v in ids.values()}
    out: list[dict] = []
    for n in nodes:
        body = n.get("body") or ""
        meta, _ = mod_index.parse_front_matter(body)
        slug = meta.get("wowsp-mod")
        if not slug:
            continue
        idinfo = by_number.get(n["number"]) or ids.get(slug) or {}
        aliases = [a.strip() for a in (meta.get("aliases") or "").split(",") if a.strip()]
        plain_pkgs = mod_index.keep_installable(
            [{"url": url, "sha256": sha.lower(), "size": int(kb) * 1024, "name": name}
             for name, url, kb, sha in mod_index.DOWNLOAD_RE.findall(
                 mod_index.PRESET_LINE_RE.sub("", body))],
            f"{slug} sync-scan")
        presets = mod_index.parse_presets(body, f"{slug} sync-scan")
        out.append({
            "slug": slug,
            "number": n["number"],
            "id": idinfo.get("id", ""),
            "title": n.get("title") or "",
            "body": body,
            "node": n,
            "closed": bool(n.get("closed")),
            "fm": meta,
            "version": meta.get("version", "0"),
            "game": meta.get("game", "*"),
            "category": meta.get("category", "aux"),
            "aliases": aliases,
            "aslain_ids": [a for a in aliases if ASLAIN_ID_RE.match(a)],
            "packages": plain_pkgs,
            "presets": presets,
            "stale": parse_stale_block(body),
        })
    print(f"{len(out)} mod threads on Discussions "
          f"({sum(1 for t in out if t['closed'])} closed)", flush=True)
    return out


def bundle_implicit_packages(mods: list[dict], implicit: list[dict]) -> int:
    """Attach each <Implicit> shared-runtime package to every selected mod
    listed in its RequiresAny (returns the number of package refs added).
    Bundling is per-build: a package is skipped when the mod already carries
    the same url or upstream token."""
    by_mod: dict = {}
    for pkg in implicit:
        if EXCLUDE_IMPLICIT_NAME_RE.search(pkg.get("name", "")):
            continue
        for mid in pkg["requires_any"]:
            by_mod.setdefault(mid, []).append(pkg)
    added = 0
    for m in mods:
        for pkg in by_mod.get(m["aslain_id"], []):
            if any(p["url"] == pkg["url"] or (pkg["token"] and p["token"] == pkg["token"])
                   for p in m["packages"]):
                continue
            clone = {k: pkg[k] for k in ("url", "name", "size_kb", "token",
                                         "sha256", "size_bytes", "asset")}
            clone["order"] = len(m["packages"])
            m["packages"].append(clone)
            m["requires_runtime"] = True
            added += 1
    return added


def apply_policies(mods: list[dict], policies: dict | None = None):
    """Split selection entries by their sync policy (default "auto").
    Returns (kept, manual_ids, skipped_ids): kept entries join the normal
    flow, manual ids are frozen at apply time, skipped ids leave the
    catalog entirely and their threads are never stale-marked."""
    table = POLICY_BY_SLUG if policies is None else policies
    kept: list[dict] = []
    manual: list[str] = []
    skipped: list[str] = []
    for m in mods:
        pol = table.get(m["id"], "auto")
        m["policy"] = pol
        if pol == "skip":
            skipped.append(m["aslain_id"])
        elif pol == "manual":
            manual.append(m["id"])
            kept.append(m)
        else:
            kept.append(m)
    return kept, manual, skipped


# ---------------------------------------------------------------- classification


def classify(selection: dict, threads: list[dict]) -> dict:
    """Diff the selection against the live threads into per-action buckets.
    Pure function over both states so the selftest can exercise it offline."""
    by_slug = {t["slug"]: t for t in threads}
    plan: dict = {"changed": [], "unchanged": [], "new": [], "pending": [],
                  "stale": [], "hand": [], "closed_managed": []}
    managed: set = set()

    for t in threads:
        if not t["aslain_ids"]:
            plan["hand"].append(t["slug"])  # hand-published: never touched
            continue
        if any(aid in selection["scope_ids"] for aid in t["aslain_ids"]):
            managed.add(t["slug"])

    for rec in selection["mods"]:
        slug = rec["id"]
        thread = by_slug.get(slug)
        if thread is None:
            # Curated slugs are taxonomical (dotted); a fallback slugify id
            # means nobody curated this entry yet -> proposal only.
            if "." in slug:
                plan["new"].append({"record": rec})
            else:
                plan["pending"].append({"record": rec})
            continue
        if thread["closed"]:
            # Archived variant: the maintainer closed this thread on purpose
            # (superseded by a newer variant / folded family). Its body still
            # gets refreshed (the fold consumes the payload) and it stays
            # delisted -- closing and reopening threads are human decisions
            # this module never makes.
            plan["closed_managed"].append(slug)
        managed.add(slug)
        expected = rec["packages"]
        published = thread["packages"]
        if not published or not all(is_content_addressed(p["name"]) for p in published):
            plan["changed"].append({"record": rec, "thread": thread,
                                    "reason": "asset naming migration",
                                    "needs_download": True, "content_changed": None})
            continue
        if len(expected) != len(published):
            plan["changed"].append({"record": rec, "thread": thread,
                                    "reason": "package set changed",
                                    "needs_download": True, "content_changed": True})
            continue
        mismatch = False
        needs_download = False
        for exp, got in zip(expected, published):
            if exp["token"] is None:
                needs_download = True  # only a fresh hash can decide
                continue
            m = CONTENT_ADDR_RE.fullmatch(got["name"])
            if not m or m.group(1) != exp["token"]:
                mismatch = True
                break
        if mismatch:
            plan["changed"].append({"record": rec, "thread": thread,
                                    "reason": "package content changed",
                                    "needs_download": True, "content_changed": True})
        elif needs_download:
            plan["changed"].append({"record": rec, "thread": thread,
                                    "reason": "tokenless package hash check",
                                    "needs_download": True, "content_changed": None})
        else:
            plan["unchanged"].append({"record": rec, "thread": thread})

    for t in threads:
        if t["slug"] in managed or not t["aslain_ids"]:
            continue
        if any(aid in selection.get("policy_skipped_ids", ()) for aid in t["aslain_ids"]):
            continue  # policy skip is a deliberate freeze, never a stale mark
        reason = None
        for aid in t["aslain_ids"]:
            if aid in selection["disabled_ids"]:
                reason = f"disabled upstream: {selection['disabled_ids'][aid]}"
                break
        if reason is None:
            for aid in t["aslain_ids"]:
                if aid not in selection["catalog_ids"]:
                    reason = "removed from the upstream catalog"
                    break
        if reason is None:
            for aid in t["aslain_ids"]:
                if aid in selection["out_of_scope_ids"]:
                    reason = "moved out of the ingested scope"
                    break
        if reason:
            plan["stale"].append({"thread": t, "reason": reason})
    return plan


def resolve_content_changed(entry: dict) -> bool:
    """Decide whether an entry's package bytes changed, given the fresh
    hashes: a legacy-named thread whose sha set already contains every new
    hash keeps its old version (naming migration only)."""
    rec, thread = entry["record"], entry["thread"]
    if entry.get("content_changed") is True:
        return True
    if not entry.get("needs_download"):
        entry["content_changed"] = False
        return False
    published_shas = {p["sha256"].lower() for p in thread["packages"] if p.get("sha256")}
    if not published_shas:
        entry["content_changed"] = True
        return True
    changed = any(p["sha256"] not in published_shas for p in rec["packages"])
    entry["content_changed"] = changed
    return changed


def promote_reaudit(plan: dict) -> int:
    """Force the content guard over the whole live scope (returns the number
    of promoted entries). A guard only sees packages that get downloaded, so
    entries the diff calls "unchanged" would keep serving their already
    published packages unaudited -- exactly how the live raw-OlliN
    ShipIdentity assets survived #1634. Promoting them into the download lane
    is explicit (apply --reaudit), so normal runs stay incremental; entries
    frozen by a "manual" sync policy stay held out."""
    promoted = [e for e in plan["unchanged"]
                if e["record"].get("policy") != "manual"]
    plan["unchanged"] = [e for e in plan["unchanged"]
                         if e["record"].get("policy") == "manual"]
    for e in promoted:
        e["reason"] = "content re-audit (--reaudit)"
        e["needs_download"] = True
        e["content_changed"] = None
    plan["changed"].extend(promoted)
    return len(promoted)


# --------------------------------------------------------------------- downloads


def package_entries(data: bytes) -> list[tuple[str, int, int]]:
    """Inventory a package zip as (member name, uncompressed size, CRC-32).

    The content guard consumes this instead of trusting the upstream
    filename: component-variant carriers re-bundle the same payload under
    names that carry no marker. Directory placeholders are kept in the
    inventory; the audit's payload rule filters them out."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return [(info.filename, info.file_size, info.CRC) for info in zf.infolist()]


def _payload_entries(entries: list[tuple[str, int, int]]) -> list[tuple[str, int, int]]:
    """res_mods payload files only: skip directory placeholders and members
    outside res_mods (zip-root natives ride the installer's @game drop path,
    so they cannot collide with res_mods targets)."""
    return [(name, size, crc) for name, size, crc in entries
            if name.lower().startswith("res_mods/") and not name.endswith("/")]


def audit_package_set(
    entries_by_package: list[tuple[str, list[tuple[str, int, int]]]],
) -> tuple[list[int], list[str], list[str]]:
    """Content-based publish guard for one entry's package set.

    Returns (kept package indices, one exclusion reason per dropped package,
    warnings for legacy package-set anomalies) and raises ValueError only for
    the one shape we cannot publish safely:

    - a package whose payload includes the raw OlliN ShipIdentity template is
      excluded when that template is its whole payload (Aslain resolves the
      template's "*_INSTALLED" switches at install time; WoWSP has no such
      step and would blank new collab ships' port names, #1634), while a
      package mixing the template into functional payload refuses to publish
      (the maintainer must split it);
    - two kept packages claiming the same target path (case-insensitive) with
      identical (file_size, CRC) bytes are shared-runtime dedupe and stay
      silent. Differing bytes are a LEGACY package-set anomaly: the live
      catalog carries several (battle.monitor.afk, battle.marker.consumables),
      so the publish continues with a warning -- the app's install merge now
      keeps the FIRST package's copy deterministically and reports the
      conflict, instead of letting extraction order decide. Maintainers
      resolve the upstream duplicate separately; hard-failing here would make
      the content-guard migration (apply --reaudit) impossible on live data.

    Pure function over already-inventoried zips so the offline selftest can
    drive every rule.
    """
    kept: list[int] = []
    excluded: list[str] = []
    warnings: list[str] = []
    claimed: dict[str, tuple[int, int, int]] = {}
    for idx, (pkg_name, entries) in enumerate(entries_by_package):
        payload = _payload_entries(entries)
        template = [e for e in payload
                    if e[0].lower().endswith(SHIP_IDENTITY_TEMPLATE_PATH)]
        if template:
            if all(e[0].lower().startswith(SHIP_IDENTITY_TEMPLATE_DIR)
                   for e in payload):
                excluded.append(SHIP_IDENTITY_EXCLUDE_REASON)
                continue
            raise ValueError(
                f"{pkg_name}: contains the raw OlliN ShipIdentity template "
                f"({template[0][0]}) mixed with functional payload; refusing to "
                "publish -- split the template out of the package")
        for rel, size, crc in payload:
            key = rel.lower()
            prior = claimed.get(key)
            if prior is None:
                claimed[key] = (idx, size, crc)
            elif prior[0] != idx and (prior[1], prior[2]) != (size, crc):
                warnings.append(
                    f"legacy duplicate target {rel!r} is written by both "
                    f"{entries_by_package[prior[0]][0]!r} and {pkg_name!r} with "
                    "different content; publishing both (the app keeps the first "
                    "package's copy and reports the conflict) -- resolve the "
                    "upstream duplicate separately")
        kept.append(idx)
    return kept, excluded, warnings


def download_record_packages(rec: dict, cache: Path) -> None:
    """Fetch (or reuse cached) package bytes, validate the container, repack
    7z outliers, and assign content-addressed asset names + hashes."""
    pkgs_dir = cache / "packages" / rec["id"]

    def one(p: dict) -> None:
        dest = pkgs_dir / p["name"]
        if dest.exists() and dest.stat().st_size > 0:
            data = dest.read_bytes()
        else:
            print(f"  GET {rec['id']}/{p['name']}", flush=True)
            data = pub.fetch_binary(p["url"], dest).read_bytes()
        if not pub.looks_like_zip(data):
            if data.startswith(pub.SEVENZ_MAGIC):
                binary = pub.sevenz_binary()
                if not binary:
                    raise SystemExit(f"7z container {p['name']} but no 7z binary on this machine")
                data = pub.rezip_sevenz(dest, binary)
                dest.write_bytes(data)
            else:
                raise SystemExit(f"{rec['id']}/{p['name']}: not a zip archive "
                                 f"(magic {data[:6].hex()})")
        # Preview/screenshot junk is stripped before hashing, so no newly
        # ingested version can serve promo material (the app's install
        # filter is the second half of the same rule). The upstream bytes
        # are kept under raw_sha256 for diagnostics/reports.
        raw = data
        cleaned, pruned_junk = mod_package_hygiene.strip_zip_bytes(data)
        if pruned_junk:
            data = cleaned
            dest.write_bytes(data)
            print(f"  pruned {pruned_junk} preview/screenshot file(s): "
                  f"{rec['id']}/{p['name']}", flush=True)
        p["raw_sha256"] = sha256_hex(raw)
        p["pruned_files"] = pruned_junk
        p["sha256"] = sha256_hex(data)
        p["size_bytes"] = len(data)
        p["asset"] = (f"pkg7-{p['sha256'][:12]}.zip" if p["token"] is None
                      else f"pkg-{p['token']}.zip")
        # In-memory inventory for the content guard below: auditing must not
        # re-read a multi-hundred-MB package from disk just to list members.
        p["_entries"] = package_entries(data)

    with concurrent.futures.ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as ex:
        list(ex.map(one, rec["packages"]))

    # Content guard: the upstream filename is not trustworthy -- the live
    # 2026-11-06/07 assets were component-variant packages whose names carried
    # no marker yet re-bundled the raw OlliN ShipIdentity template into
    # dependent entries. Audit the zips we just staged (the upload source of
    # truth); only the raw-template shapes are fatal, legacy duplicate targets
    # ride the report as warnings (see audit_package_set).
    entries_by_package = [(p["name"], p["_entries"]) for p in rec["packages"]]
    kept: list[int] = list(range(len(rec["packages"])))
    excluded_reasons: list[str] = []
    audit_warnings: list[str] = []
    try:
        kept, excluded_reasons, audit_warnings = audit_package_set(entries_by_package)
    except ValueError as exc:
        raise SystemExit(f"{rec['id']}: {exc}") from None
    finally:
        # Never leak the in-memory inventory into the record/JSON:
        # thread bodies and mod-index.json only ever see url/sha/name/size.
        for p in rec["packages"]:
            p.pop("_entries", None)
    if audit_warnings:
        # Reporting metadata only: run_apply folds these into the report.
        rec["audit_warnings"] = list(audit_warnings)
        for msg in audit_warnings:
            print(f"  warning {rec['id']}: {msg}", flush=True)
    if excluded_reasons:
        excluded_idx = [i for i in range(len(rec["packages"]))
                        if i not in set(kept)]
        # Reporting metadata only: never serialized into thread bodies or
        # mod-index.json (rebuild_body/gate_index never read it).
        rec["excluded_packages"] = []
        for idx, reason in zip(excluded_idx, excluded_reasons):
            p = rec["packages"][idx]
            print(f"  excluded {rec['id']}/{p['name']}: {reason}", flush=True)
            rec["excluded_packages"].append({"name": p["name"], "reason": reason})
        # Drop the excluded packages, keep the survivors' upstream order and
        # renumber the order keys (body builder + staging walk this list).
        rec["packages"] = [rec["packages"][i] for i in kept]
        for order, p in enumerate(rec["packages"]):
            p["order"] = order
    if not rec["packages"]:
        raise SystemExit(
            f"{rec['id']}: the content guard excluded every package "
            f"({len(excluded_reasons)} raw OlliN ShipIdentity template "
            "package(s)); refusing to publish an entry with no package")


def release_assets() -> dict:
    rel = json.loads(pub.gh(f"repos/{REPO}/releases/tags/{RELEASE_TAG}"))
    return {a["name"]: a for a in rel.get("assets", [])}


def ensure_release() -> None:
    out = subprocess.run(["gh", "release", "view", RELEASE_TAG, "--repo", REPO],
                         capture_output=True, text=True)
    if out.returncode != 0:
        subprocess.run(
            ["gh", "release", "create", RELEASE_TAG, "--repo", REPO,
             "--title", "Mod Hub package store", "--latest=false",
             "--notes", "Mod Hub package store. Assets are re-hosted copies of third-party mods "
                        "ingested from Aslain's WoWs Modpack; see the linked Discussions threads "
                        "for hashes, sources and attribution."],
            check=True)


def upload_assets(uploads: dict, assets: dict) -> int:
    """Upload staged files whose release asset is missing or carries a
    different digest; identical content skips (idempotent re-runs)."""
    todo = []
    for name, staged in sorted(uploads.items()):
        info = assets.get(name)
        local = sha256_hex(staged.read_bytes())
        if info and info.get("digest") == f"sha256:{local}":
            continue
        todo.append((staged, name))
    uploaded = 0
    for i in range(0, len(todo), UPLOAD_BATCH):
        batch = todo[i:i + UPLOAD_BATCH]
        args = ["gh", "release", "upload", RELEASE_TAG, "--repo", REPO, "--clobber"]
        for staged, _name in batch:
            args.append(str(staged))
        subprocess.run(args, check=True)
        uploaded += len(batch)
        print(f"  uploaded {i + len(batch)}/{len(todo)} assets", flush=True)
    if todo:
        print(f"{uploaded} assets uploaded ({len(uploads) - uploaded} already current)", flush=True)
    return uploaded


# ------------------------------------------------------------------- thread bodies


def fm_text(rec: dict, version: str, game: str, extra_aliases: list | None = None) -> str:
    lines = ["---",
             f"wowsp-mod: {rec['id']}",
             f"version: {version}",
             f'game: "{game}"',
             f"category: {rec['category']}"]
    pub.append_author_lines(lines, rec["id"])
    names = pub.aliases_of(rec)
    for alias in extra_aliases or []:
        if alias not in names:
            names.append(alias)
    if names:
        lines.append(f"aliases: {', '.join(names)}")
    lines += ["license: Unspecified (upstream)", "---"]
    return "\n".join(lines)


def stale_block_text(reason: str, since: str = "", content_version: str = "") -> str:
    lines = ["<!--", "wowsp:sync-stale", f"reason: {reason}"]
    if since:
        lines.append(f"since: {since}")
    if content_version:
        lines.append(f"content_version: {content_version}")
    lines += ["wowsp:sync-stale", "-->"]
    return "\n".join(lines)


def rewrite_front_matter(body: str, new_fm: str, stale_reason: str = "",
                         since: str = "", content_version: str = "") -> str:
    """Replace the front-matter block (keeping the rest of the body
    byte-for-byte) and add/remove the hidden stale marker. This is the
    minimal-diff path for unchanged entries and stale (de)marking."""
    body = STALE_BLOCK_RE.sub("", body)
    body = body.replace(STALE_NOTE + "\n\n", "").replace("\n\n" + STALE_NOTE, "")
    body = body.replace(STALE_NOTE, "")
    body = re.sub(r"\n{3,}", "\n\n", body)
    m = mod_index.FRONT_MATTER_RE.match(body)
    rest = body[m.end():] if m else body
    rest = rest.lstrip("\n")
    if stale_reason:
        return (new_fm.rstrip("\n") + "\n\n" + stale_block_text(stale_reason, since, content_version)
                + "\n\n" + STALE_NOTE + "\n\n" + rest)
    return new_fm.rstrip("\n") + "\n\n" + rest


def rebuild_body(rec: dict, thread: dict | None, version: str, game: str,
                 stale_reason: str = "", content_version: str = "") -> str:
    """Full body regeneration for content-changed / new entries: fresh
    front-matter and download lines, while the irreplaceable payload already
    on the thread (gallery images, preset blocks) is carried over verbatim."""
    slug = rec["id"]
    i18n = pub.merged_i18n(slug, rec, thread["body"] if thread else "")
    fm = fm_text(rec, version, game, extra_aliases=thread["aslain_ids"] if thread else None)
    parts: list[str] = [fm, ""]
    if stale_reason:
        since = (thread.get("stale") or {}).get("since", "") if thread else ""
        parts += [stale_block_text(stale_reason, since, content_version), "", STALE_NOTE, ""]
    if i18n:
        parts += [pub.build_i18n_block(i18n), "", pub.build_i18n_details(i18n), ""]
    gallery = []
    if thread:
        gallery = [m.group(0) for m in re.finditer(r"!\[[^\]]*\]\((https://[^)]+)\)",
                                                   thread["body"])]
    if gallery:
        parts += gallery + [""]
    name_en = (pub.DESC_I18N_NAMES.get(slug) or {}).get("en-US") or rec["name_en"] or slug
    name_zh = (pub.DESC_I18N_NAMES.get(slug) or {}).get("zh-CN") or rec["name_zh"] or ""
    title = f"**{name_zh}** / {name_en}" if name_zh else f"**{name_en}**"
    parts += [title, ""]
    desc = (pub.DESC_I18N.get(slug) or {}).get("en-US") or rec["description"] or ""
    if desc:
        parts += [desc, ""]
    if rec.get("requires_runtime"):
        parts += [
            "> ℹ️ 本条目自带运行所需的共享组件包（TTaro 公共组件 / ModForge 蓝图引擎等）——"
            "多个插件共享同一份，若卸载其中一个插件后同类插件失效，重装任意一个即可恢复。 "
            "/ This entry ships the shared runtime package it needs (the TTaro utilities, "
            "the ModForge blueprint engine, ...). Several mods share one copy -- if a "
            "sibling mod stops working after an uninstall, reinstall any of them.",
            "",
        ]
    if thread:
        pm = pub.PRESETS_BLOCK_SRC_RE.search(thread["body"])
        if pm:
            parts += [pm.group(0), ""]
    parts += ["### 下载 / Download", ""]
    for p in rec["packages"]:
        parts.append(f"- [`{p['asset']}`]({download_url(p['asset'])}) — "
                     f"{max(1, p['size_bytes'] // 1024)} KB · SHA-256 `{p['sha256']}`")
    if thread:
        for m in mod_index.PRESET_LINE_RE.finditer(thread["body"]):
            parts.append(m.group(0))
    parts += ["", "| | |", "| --- | --- |",
              f"| 版本 / version | `{version}` |",
              f"| 兼容 / game | `{game}` |"]
    source = "[Aslain's WoWs Modpack](https://aslain.com/) · catalog " + (content_version or "unknown")
    if rec["author_url"]:
        source += f" · [author]({rec['author_url']})"
    parts += [f"| 来源 / source | {source} |", "", pub.SIGNAL_NOTE, ""]
    return "\n".join(parts)


def refresh_thread_packages(thread: dict, body: str) -> None:
    """Keep the in-memory thread state truthful after a body rewrite so the
    GC's referenced set sees the new asset names."""
    thread["body"] = body
    if "node" in thread:
        thread["node"]["body"] = body
    thread["stale"] = parse_stale_block(body)
    thread["packages"] = mod_index.keep_installable(
        [{"url": url, "sha256": sha.lower(), "size": int(kb) * 1024, "name": name}
         for name, url, kb, sha in mod_index.DOWNLOAD_RE.findall(
             mod_index.PRESET_LINE_RE.sub("", body))],
        f"{thread['slug']} post-update")


def update_thread(thread: dict, body: str, title: str | None) -> None:
    payload: dict = {"discussionId": thread["id"], "body": body}
    if title:
        payload["title"] = title
    result = pub.gh_graphql(pub.UPDATE_MUTATION, input=payload)
    check = result["updateDiscussion"]["discussion"]["number"]
    if check != thread["number"]:
        raise SystemExit(f"{thread['slug']}: updated #{check} instead of #{thread['number']}")


def create_thread(rec: dict, body: str, repo_node: str) -> int:
    result = pub.gh_graphql(
        pub.CREATE_MUTATION,
        input={"repositoryId": repo_node,
               "categoryId": SHOW_AND_TELL_CATEGORY,
               "title": pub.thread_title({"name_en": rec["name_en"], "id": rec["id"],
                                          "version": rec["version"]}),
               "body": body})
    number = result["createDiscussion"]["discussion"]["number"]
    print(f"  + {rec['id']} -> #{number}", flush=True)
    return number


def repo_node() -> str:
    data = pub.gh_graphql(
        "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}",
        owner=REPO.split("/")[0], name=REPO.split("/")[1])
    return data["repository"]["id"]


# ------------------------------------------------------------------------- index


def gate_index(idx: dict, asset_names: set) -> tuple[int, int]:
    """Drop packages the release cannot serve (and entries emptied by that),
    for live entries only -- delisted/stale/bundled entries keep their rows so
    history stays honest. Returns (dropped, total_checked)."""
    total = 0
    dropped = 0
    for slug in list(idx["mods"]):
        entry = idx["mods"][slug]
        entry_bundled = entry.get("bundled") or any(
            v.get("bundled") for v in entry["versions"].values())
        if entry.get("delisted") or entry.get("stale") or entry_bundled:
            continue
        dead_versions = []
        for vname, v in entry["versions"].items():
            pkgs = v.get("packages") or []
            total += len(pkgs)
            kept = [p for p in pkgs if p["name"] in asset_names]
            dropped += len(pkgs) - len(kept)
            v["packages"] = kept
            presets = v.get("presets") or []
            if presets:
                kept_presets = []
                for preset in presets:
                    pp = preset.get("packages") or []
                    total += len(pp)
                    keep_p = [p for p in pp if p["name"] in asset_names]
                    dropped += len(pp) - len(keep_p)
                    if keep_p:
                        preset["packages"] = keep_p
                        kept_presets.append(preset)
                v["presets"] = kept_presets
                if kept_presets and not v["packages"]:
                    v["packages"] = kept_presets[0]["packages"]
            if not v["packages"] and not v.get("presets") and not v.get("bundled"):
                dead_versions.append(vname)
        for vname in dead_versions:
            del entry["versions"][vname]
        if not entry["versions"]:
            print(f"warning: dropping {slug} (no servable packages)", file=sys.stderr, flush=True)
            del idx["mods"][slug]
            continue
        latest = max(entry["versions"], key=mod_index.version_sort_key)
        entry["latest"] = latest
        entry["game"] = entry["versions"][latest].get("game", "*")
    return dropped, total


def build_and_upload_index(threads: list[dict], selection: dict | None, cache: Path,
                           dry: bool) -> dict:
    """Rebuild mod-index.json from the crawled threads (the one true index
    source, hand-published threads included), gate it against the release,
    upload with rollback, and report whether its bytes changed."""
    url = f"{RELEASE_URL_BASE}/mod-index.json"
    prev = b""
    try:
        prev = pub.fetch_binary(url, cache / "mod-index.prev.json").read_bytes()
    except Exception:
        prev = b""
    idx = mod_index.index_discussions([t["node"] for t in threads])
    if selection:
        idx["source"] = {"kind": "aslain-ingest",
                         "content_version": selection["content_version"],
                         "game_version": selection["game_version"]}
        for t in threads:
            if t.get("stale") and t["slug"] in idx["mods"]:
                idx["mods"][t["slug"]]["stale"] = {
                    "reason": t["stale"].get("reason", ""),
                    "since": t["stale"].get("since", ""),
                }
    elif prev:
        # index-only carries the last published source stamp forward so its
        # bytes stay stable and the digest does not repoint for nothing.
        try:
            prev_source = json.loads(prev.decode("utf-8")).get("source")
        except Exception:
            prev_source = None
        if prev_source:
            idx["source"] = prev_source
    assets = release_assets()
    dropped, total = gate_index(idx, set(assets))
    if pub.should_refuse_upload(total, dropped, len(idx["mods"])):
        sys.exit(f"refusing to publish: {dropped}/{total} packages missing from release "
                 f"{RELEASE_TAG} ({len(idx['mods'])} mods left) -- the catalog and the release "
                 "disagree; investigate before publishing")
    out = cache / "mod-index.json"
    data = (json.dumps(idx, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    index_changed = (not prev) or sha256_hex(prev) != sha256_hex(data)
    result = {"index_changed": index_changed,
              "index_sha256": sha256_hex(data),
              "index_mods": len(idx["mods"]),
              "index_packages": sum(len(v.get("packages") or [])
                                    for m in idx["mods"].values()
                                    for v in m["versions"].values()),
              "dropped_packages": dropped}
    print(f"mod-index.json: {len(idx['mods'])} mods, {result['index_packages']} packages, "
          f"{dropped} unservable dropped -> {'WOULD upload (dry)' if dry else 'uploading'}",
          flush=True)
    if dry:
        return result
    out.write_bytes(data)
    try:
        subprocess.run(["gh", "release", "upload", RELEASE_TAG, "--repo", REPO,
                        "--clobber", str(out)], check=True)
        # Verify through the API-computed asset digest: the public download
        # URL sits behind a CDN that serves stale bytes right after a
        # clobber, so the byte readback here raced the edge cache and rolled
        # back a perfectly good publish. Readback stays as the fallback for
        # assets that carry no digest yet.
        assets_now = release_assets()
        digest = (assets_now.get("mod-index.json") or {}).get("digest", "")
        if digest and digest != f"sha256:{result['index_sha256']}":
            raise RuntimeError("published mod-index.json digest disagrees "
                               "with the local bytes")
        if not digest:
            check = pub.fetch_binary(url, cache / "mod-index.verify.json").read_bytes()
            if sha256_hex(check) != result["index_sha256"]:
                raise RuntimeError("published mod-index.json does not read "
                                   "back byte-identical")
        prev_count = len(json.loads(prev.decode("utf-8"))["mods"]) if prev else 0
        if prev_count and result["index_mods"] < prev_count * 0.9:
            raise RuntimeError(f"published index lost >10% of entries "
                               f"({prev_count} -> {result['index_mods']})")
    except Exception as exc:
        if prev:
            print(f"publish failed ({exc}); rolling the previous index back", file=sys.stderr,
                  flush=True)
            (cache / "mod-index.rollback.json").write_bytes(prev)
            subprocess.run(["gh", "release", "upload", RELEASE_TAG, "--repo", REPO,
                            "--clobber", str(cache / "mod-index.rollback.json")], check=True)
        raise
    return result


# ----------------------------------------------------------------------------- GC


def gc_assets(threads: list[dict], dry: bool) -> list[str]:
    """Delete release assets no thread references anymore (legacy naming
    leftovers, superseded content), at most GC_MAX_DELETIONS per run and only
    after a 24h grace so clients with a cached index keep a servable tree."""
    rel = json.loads(pub.gh(f"repos/{REPO}/releases/tags/{RELEASE_TAG}"))
    assets = rel.get("assets", [])
    referenced = {"mod-index.json"}
    for t in threads:
        for p in t["packages"]:
            referenced.add(p["name"])
        for preset in t["presets"]:
            for p in preset.get("packages") or []:
                referenced.add(p["name"])
    if len(referenced) < GC_MIN_REFERENCED:
        print(f"gc skipped: only {len(referenced)} referenced names (parse bug guard)", flush=True)
        return []
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=GC_MIN_AGE_HOURS)
    index_asset = next((a for a in assets if a["name"] == "mod-index.json"), None)
    if index_asset:
        try:
            published_at = datetime.datetime.fromisoformat(
                index_asset["updated_at"].replace("Z", "+00:00"))
        except (ValueError, KeyError, AttributeError):
            published_at = None
        if published_at and datetime.datetime.now(datetime.timezone.utc) - published_at \
                < datetime.timedelta(hours=GC_MIN_AGE_HOURS):
            print("gc skipped: the live index is younger than the "
                  f"{GC_MIN_AGE_HOURS}h client-cache grace", flush=True)
            return []
    doomed = []
    for a in assets:
        if a["name"] in referenced:
            continue
        try:
            updated = datetime.datetime.fromisoformat(a["updated_at"].replace("Z", "+00:00"))
        except (ValueError, KeyError, AttributeError):
            continue
        if updated < cutoff:
            doomed.append(a)
    doomed = doomed[:GC_MAX_DELETIONS]
    if not doomed:
        return []
    if dry:
        print(f"gc would delete {len(doomed)} unreferenced assets (dry)", flush=True)
        return [a["name"] for a in doomed]
    for a in doomed:
        pub.gh("-X", "DELETE", f"repos/{REPO}/releases/assets/{a['id']}")
    print(f"gc deleted {len(doomed)} unreferenced assets", flush=True)
    return [a["name"] for a in doomed]


# -------------------------------------------------------------------------- report


def render_summary(report: dict) -> str:
    counts = report.get("counts") or {}
    up = report.get("upstream") or {}
    actions = report.get("actions") or {}
    lines = ["## Mod Hub sync report", ""]
    if up:
        lines.append(
            f"- mode: `{report['mode']}` · ran at `{report['ran_at']}` · {report['duration_s']}s")
        lines.append(
            f"- upstream: `{up.get('content_version', '?')}` "
            f"(game `{up.get('game_version', '?')}`, range `{up.get('game', '?')}`), "
            f"{up.get('mods', 0)} mods / {up.get('packages', 0)} packages")
    else:
        lines.append(f"- mode: `{report['mode']}` · ran at `{report['ran_at']}` · "
                     f"{report['duration_s']}s")
    if counts:
        lines.append(
            f"- unchanged {counts.get('unchanged', 0)} · changed {counts.get('changed', 0)} · "
            f"new {counts.get('new', 0)} · pending curation {counts.get('pending', 0)} · "
            f"stale {counts.get('stale', 0)} · hand-published {counts.get('hand', 0)} · "
            f"closed-managed {counts.get('closed_managed', 0)} (kept fresh, never reopened) · "
            f"held by policy {counts.get('held_manual', 0)}")
    if actions:
        lines.append(
            f"- actions: {actions.get('assets_uploaded', 0)} assets uploaded, "
            f"{actions.get('threads_updated', 0)} threads updated, "
            f"{actions.get('threads_created', 0)} created, "
            f"{actions.get('threads_marked_stale', 0)} marked stale, "
            f"{actions.get('gc_deleted', 0)} pruned; "
            f"index {'changed' if actions.get('index_changed') else 'unchanged'} "
            f"({actions.get('index_mods', 0)} mods)")
    if report.get("changed"):
        lines += ["", "### Changed entries", ""]
        for c in report["changed"]:
            ver = f" -> version `{c['version']}`" if c.get("version") else ""
            lines.append(f"- `{c['slug']}` ({c['reason']}){ver}")
    if report.get("stale"):
        lines += ["", "### Sync source closed (pending review)", ""]
        for s in report["stale"]:
            lines.append(f"- `{s['slug']}` (#{s['number']}): {s['reason']}")
    if report.get("pending"):
        lines += ["", "### New upstream entries awaiting curation", ""]
        for p in report["pending"]:
            lines.append(f"- `{p['aslain_id']}` -> proposed slug `{p['slug']}` — {p['name_en']}")
        lines += ["", "Curate scripts/mod_hub_slugs.py (authors/desc/families optional), then "
                     "dispatch the workflow with mode=apply, include_new=true."]
    if report.get("new_published"):
        lines += ["", "### Published new entries", ""]
        for p in report["new_published"]:
            lines.append(f"- `{p['slug']}` -> #{p['number']}")
    if report.get("held_manual"):
        lines += ["", "### Held by sync policy (manual approval required)", ""]
        for slug in report["held_manual"]:
            lines.append(f"- `{slug}`")
        lines += ["", "Flip the slug's policy in scripts/mod_hub_sync_policies.json to auto, then re-run."]
    if report.get("warnings"):
        lines += ["", "### Warnings", ""]
        for w in report["warnings"]:
            lines.append(f"- {w}")
    return "\n".join(lines) + "\n"


CREATE_ISSUE_MUTATION = """
mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { issue { number } }
}
"""

UPDATE_ISSUE_MUTATION = """
mutation($input: UpdateIssueInput!) {
  updateIssue(input: $input) { issue { number } }
}
"""


def _verify_issue_body(number: int, body: str) -> None:
    """A 200/GraphQL-ok from either write lane is not proof the body
    landed: the 2026-11-12 empty-stdin PATCH no-op reported "report issue
    updated" on every run while the tracker body stayed stale for six
    days. Re-read and compare before declaring the tracker refreshed."""
    got = json.loads(pub.gh(f"repos/{REPO}/issues/{number}")).get("body")
    if got != body:
        raise SystemExit(
            f"issue #{number} body write did not stick "
            f"(stored {len(got or '')} chars, wanted {len(body)}); "
            "both write lanes claimed success")


def ensure_issue(title: str, body: str) -> int:
    """Create or overwrite the open issue carrying exactly this title. REST
    first, GraphQL on the installation-token 422 (see below)."""
    query = urllib.parse.quote(f'repo:{REPO} is:issue is:open in:title "{title}"')
    hits = json.loads(pub.gh(f"search/issues?q={query}&per_page=1")).get("items") or []
    existing = hits[0] if hits and hits[0].get("title") == title else None
    if existing:
        payload = json.dumps({"body": body})
        try:
            pub.gh("-X", "PATCH", f"repos/{REPO}/issues/{existing['number']}",
                   input_text=payload)
        except RuntimeError:
            # GitHub validates issue bodies through a task-list "links" schema
            # on REST writes made with installation tokens ("links/0/schema",
            # HTTP 422) and rejects them even though the identical bytes POST
            # fine with a user token. GraphQL takes the body verbatim, so that
            # is the fallback lane.
            node_id = existing.get("node_id")
            if not node_id:
                node_id = json.loads(
                    pub.gh(f"repos/{REPO}/issues/{existing['number']}")).get("node_id")
            result = pub.gh_graphql(UPDATE_ISSUE_MUTATION,
                                    input={"id": node_id, "body": body})
            check = result["updateIssue"]["issue"]["number"]
            if check != existing["number"]:
                raise SystemExit(f"updated issue #{check} instead of "
                                 f"#{existing['number']}")
        _verify_issue_body(existing["number"], body)
        print(f"report issue updated: #{existing['number']}", flush=True)
        return existing["number"]
    payload = json.dumps({"title": title, "body": body})
    try:
        created = json.loads(pub.gh("-X", "POST", f"repos/{REPO}/issues", input_text=payload))
        number = created["number"]
    except RuntimeError:
        result = pub.gh_graphql(CREATE_ISSUE_MUTATION,
                                input={"repositoryId": repo_node(), "title": title,
                                       "body": body})
        number = result["createIssue"]["issue"]["number"]
    _verify_issue_body(number, body)
    print(f"report issue created: #{number}", flush=True)
    return number


# --------------------------------------------------------------------------- runs


def build_report(mode: str, selection: dict, threads: list[dict], plan: dict,
                 started: float, dry: bool) -> dict:
    counts = {
        "unchanged": len(plan["unchanged"]),
        "changed": len(plan["changed"]),
        "new": len(plan["new"]),
        "pending": len(plan["pending"]),
        "stale": len(plan["stale"]),
        "hand": len(plan["hand"]),
        "closed_managed": len(plan["closed_managed"]),
    }
    changed_out = []
    for e in plan["changed"]:
        changed_out.append({
            "slug": e["record"]["id"],
            "aslain_id": e["record"]["aslain_id"],
            "reason": e["reason"],
            "content_changed": e.get("content_changed"),
            "version": (selection["version"] if e.get("content_changed")
                        else e["thread"]["version"]) if not dry else None,
        })
    return {
        "mode": mode,
        "ran_at": now_iso(),
        "duration_s": round(time.time() - started, 1),
        "upstream": {
            "content_version": selection["content_version"],
            "game_version": selection["game_version"],
            "game": selection["game"],
            "bin_max": selection["bin_max"],
            "mods": len(selection["mods"]),
            "packages": sum(len(m["packages"]) for m in selection["mods"]),
            "unique_tokens": len({p["token"] for m in selection["mods"]
                                  for p in m["packages"] if p["token"]}),
            "implicit_packages": selection.get("implicit_packages", 0),
            "implicit_bundled": selection.get("implicit_bundled", 0),
        },
        "counts": counts,
        "changed": changed_out,
        "stale": [{"slug": s["thread"]["slug"], "number": s["thread"]["number"],
                   "reason": s["reason"]} for s in plan["stale"]],
        "pending": [{"aslain_id": p["record"]["aslain_id"], "slug": p["record"]["id"],
                     "name_en": p["record"]["name_en"]} for p in plan["pending"]],
        "new_published": [],
        "closed_managed": sorted(plan["closed_managed"]),
        "actions": {"assets_uploaded": 0, "threads_updated": 0, "threads_created": 0,
                    "threads_marked_stale": 0, "gc_deleted": 0, "index_changed": False,
                    "index_sha256": "", "index_mods": 0, "index_packages": 0},
        "warnings": list(selection.get("duplicates") or []),
    }


def run_detect(args) -> int:
    started = time.time()
    cache = Path(args.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    selection = collect_selection(cache)
    threads = fetch_thread_state(args.repo)
    plan = classify(selection, threads)
    report = build_report("detect", selection, threads, plan, started, True)
    print(render_summary(report))
    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                   encoding="utf-8")
    return 0


def run_apply(args) -> int:
    started = time.time()
    cache = Path(args.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    selection = collect_selection(cache)
    threads = fetch_thread_state(args.repo)
    plan = classify(selection, threads)
    held_manual = [e for e in plan["changed"] if e["record"].get("policy") == "manual"]
    plan["changed"] = [e for e in plan["changed"] if e["record"].get("policy") != "manual"]
    held_new = [e for e in plan["new"] if e["record"].get("policy") == "manual"]
    plan["new"] = [e for e in plan["new"] if e["record"].get("policy") != "manual"]
    # One-shot guard migration: after a content guard changes, run
    # "apply --reaudit" once so already-published packages are re-downloaded
    # and re-audited; regular runs only audit entries whose packages changed.
    reaudited = promote_reaudit(plan) if args.reaudit else 0
    report = build_report("apply", selection, threads, plan, started, args.dry_run)
    report["held_manual"] = [e["record"]["id"] for e in held_manual] + \
        [e["record"]["id"] for e in held_new]
    report["counts"]["held_manual"] = len(held_manual) + len(held_new)
    if args.reaudit:
        report["reaudit_entries"] = reaudited
        report["counts"]["reaudited"] = reaudited
        report["warnings"].append(
            f"re-audit: forced a download + content-guard pass over "
            f"{reaudited} previously-unchanged entries")
    cv = selection["content_version"]
    if plan["new"] and not args.include_new:
        report["warnings"].append(
            f"{len(plan['new'])} new upstream entries await curation; re-run with "
            "--include-new after adding them to scripts/mod_hub_slugs.py")

    # 1) download + hash every changed/new entry; resolve legacy-sha comparisons
    needs = [e for e in plan["changed"] if e.get("needs_download")]
    if not args.dry_run and needs:
        print(f"downloading {sum(len(e['record']['packages']) for e in needs)} packages "
              f"for {len(needs)} changed entries", flush=True)
    for e in needs:
        if args.dry_run:
            continue
        download_record_packages(e["record"], cache)
        resolve_content_changed(e)
    for e in plan["changed"]:
        if not e.get("needs_download"):
            e["content_changed"] = False
    if not args.dry_run:
        # The report must reflect post-download reality (a naming-migration
        # entry whose bytes stayed equal keeps its old version).
        for e in plan["changed"]:
            e["version"] = (selection["version"] if e.get("content_changed")
                            else e["thread"]["version"])
        report["changed"] = [
            {"slug": e["record"]["id"], "aslain_id": e["record"]["aslain_id"],
             "reason": e["reason"], "content_changed": e.get("content_changed"),
             "version": e.get("version")}
            for e in plan["changed"]
        ]
    if args.include_new and not args.dry_run:
        for e in plan["new"]:
            if "." in e["record"]["id"]:
                download_record_packages(e["record"], cache)

    # Content-guard findings are report data, not just console noise: legacy
    # duplicate targets warn (the app install keeps the first package's copy
    # deterministically and reports the conflict) and the excluded raw-OlliN
    # template packages are listed so a maintainer sees exactly what dropped.
    if not args.dry_run:
        for e in plan["changed"] + [e for e in plan["new"]
                                    if args.include_new and "." in e["record"]["id"]]:
            rec = e["record"]
            for msg in rec.get("audit_warnings") or []:
                report["warnings"].append(f"{rec['id']}: {msg}")
            for item in rec.get("excluded_packages") or []:
                report.setdefault("excluded_packages", []).append(
                    {"id": rec["id"], "package": item.get("name", ""),
                     "reason": item.get("reason", "")})

    # 2) stage + upload content-addressed assets for changed/new entries
    uploads: dict = {}
    assets = release_assets()
    if args.dry_run:
        report["warnings"].append("dry run: asset upload estimate skipped (no downloads)")
    else:
        for e in plan["changed"] + [e for e in plan["new"]
                                    if args.include_new and "." in e["record"]["id"]]:
            rec = e["record"]
            if not rec["packages"][0].get("sha256"):
                report["warnings"].append(
                    f"{rec['id']}: skipped asset staging (packages not downloaded)")
                continue
            for p in rec["packages"]:
                staged = cache / "assets" / p["asset"]
                staged.parent.mkdir(parents=True, exist_ok=True)
                staged.write_bytes((cache / "packages" / rec["id"] / p["name"]).read_bytes())
                uploads[p["asset"]] = staged
        if uploads:
            # Package-content gate (crash gc-20261101232118338-22840): the
            # staged bytes are the upload source of truth, so this staging
            # dict is the single landing point before anything uploads. A
            # corrupt .swf member aborts the run (same lane as the container
            # check in download_record_packages); unresolvable .swf
            # references ride the report as warnings - the app-side
            # installer gate, with the client index, stays the authority
            # on stock-asset references.
            for name, staged in sorted(uploads.items()):
                rep = mod_package_check.scan_path(staged, name)
                if rep.bad_swf_members:
                    raise SystemExit(
                        f"{name}: corrupt .swf member(s) fail the FWS/CWS/ZWS "
                        f"magic check: {', '.join(rep.bad_swf_members)}")
                for f in rep.findings:
                    report["warnings"].append(
                        f"{name}: .swf reference {f.ref_basename} is not in the "
                        f"package (referenced by {', '.join(f.referencing_members)})")
            ensure_release()
            report["actions"]["assets_uploaded"] = upload_assets(uploads, assets)

    # 3) thread mutations
    updates: list = []
    for e in plan["changed"]:
        rec, t = e["record"], e["thread"]
        version = selection["version"] if e.get("content_changed") else t["version"]
        e["version"] = version
        new_body = rebuild_body(rec, t, version, selection["game"], "", cv)
        if new_body.strip() != t["body"].strip():
            title = pub.thread_title({"name_en": rec["name_en"], "id": rec["id"],
                                      "version": version}) if e.get("content_changed") else None
            updates.append((t, new_body, title))
    for e in plan["unchanged"]:
        rec, t = e["record"], e["thread"]
        fm_new = fm_text(rec, t["version"], selection["game"],
                         extra_aliases=t["aslain_ids"]) + "\n"
        m = mod_index.FRONT_MATTER_RE.match(t["body"])
        cur_fm = m.group(0) if m else ""
        if cur_fm.strip() != fm_new.strip() or t.get("stale"):
            new_body = rewrite_front_matter(t["body"], fm_new)
            if new_body != t["body"]:
                updates.append((t, new_body, None))
    for s in plan["stale"]:
        t = s["thread"]
        if t.get("stale") and t["stale"].get("reason") == s["reason"]:
            continue  # already marked with the same reason
        m = mod_index.FRONT_MATTER_RE.match(t["body"])
        if not m:
            report["warnings"].append(f"{t['slug']}: stale marking skipped (no front matter)")
            continue
        since = (t.get("stale") or {}).get("since", now_iso())
        new_body = rewrite_front_matter(t["body"], m.group(0), s["reason"], since, cv)
        updates.append((t, new_body, None))
        report["actions"]["threads_marked_stale"] += 1

    if args.dry_run:
        bump = sum(1 for e in plan["changed"] if e.get("content_changed"))
        print(f"{len(updates)} threads would be rewritten, {bump} versions would bump, "
              f"{len(plan['new'])} new ({'would create' if args.include_new else 'proposal only'}) "
              f"+ {len(plan['pending'])} pending curation, {len(plan['stale'])} stale marks",
              flush=True)
    else:
        if plan["new"] and args.include_new:
            uncurated = [e for e in plan["new"] if "." not in e["record"]["id"]]
            if uncurated:
                report["warnings"].append(
                    f"{len(uncurated)} new entries lack curated slugs; add them to "
                    "scripts/mod_hub_slugs.py first")
            rid = None
            for e in plan["new"]:
                rec = e["record"]
                if "." not in rec["id"]:
                    continue
                if rid is None:
                    rid = repo_node()
                body = rebuild_body(rec, None, rec["version"], selection["game"], "", cv)
                number = create_thread(rec, body, rid)
                report["new_published"].append({"slug": rec["id"], "number": number})
                report["actions"]["threads_created"] += 1
                threads.append({
                    "slug": rec["id"], "number": number,
                    "node": {"number": number, "title": body.splitlines()[0],
                             "body": body, "closed": False,
                             "author": {"login": "wowsp-sync"},
                             "comments": {"nodes": []}},
                    "packages": [{"name": p["asset"]} for p in rec["packages"]],
                    "presets": [],
                    "stale": None})
                time.sleep(THREAD_UPDATE_SLEEP)
        for i, (t, body, title) in enumerate(updates):
            update_thread(t, body, title)
            refresh_thread_packages(t, body)
            report["actions"]["threads_updated"] += 1
            if (i + 1) % 20 == 0:
                print(f"  updated {i + 1}/{len(updates)} threads", flush=True)
            time.sleep(THREAD_UPDATE_SLEEP)
        if updates:
            print(f"{len(updates)} threads rewritten", flush=True)

    # 4) index + 5) GC (skipped entirely on dry runs)
    if not args.dry_run:
        result = build_and_upload_index(threads, selection, cache, False)
        for key in ("index_changed", "index_sha256", "index_mods", "index_packages"):
            report["actions"][key] = result[key]
        if args.no_gc:
            print("gc skipped (--no-gc)", flush=True)
        else:
            report["actions"]["gc_deleted"] = len(gc_assets(threads, False))
    else:
        report["warnings"].append("dry run: index and GC skipped")

    print(render_summary(report))
    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                   encoding="utf-8")
    if report["warnings"]:
        print("warnings:", file=sys.stderr, flush=True)
        for w in report["warnings"]:
            print(f"  - {w}", file=sys.stderr, flush=True)
    return 0


def run_index_only(args) -> int:
    started = time.time()
    cache = Path(args.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    threads = fetch_thread_state(args.repo)
    report = {
        "mode": "index-only", "ran_at": now_iso(),
        "duration_s": round(time.time() - started, 1),
        "upstream": {}, "counts": {}, "changed": [], "stale": [], "pending": [],
        "new_published": [],
        "actions": {"assets_uploaded": 0, "threads_updated": 0, "threads_created": 0,
                    "threads_marked_stale": 0, "gc_deleted": 0, "index_changed": False,
                    "index_sha256": "", "index_mods": 0, "index_packages": 0},
        "warnings": [],
    }
    result = build_and_upload_index(threads, None, cache, False)
    for key in ("index_changed", "index_sha256", "index_mods", "index_packages"):
        report["actions"][key] = result[key]
    print(render_summary(report))
    if args.json:
        Path(args.json).write_text(json.dumps(report, ensure_ascii=False, indent=1),
                                   encoding="utf-8")
    return 0


# ----------------------------------------------------------------------- selftest


def selftest() -> None:
    # game range derivation
    assert game_range("15.9.0") == ">=15.9 <15.10", game_range("15.9.0")
    assert game_range("16.0.1") == ">=16.0 <16.1"
    assert game_range("15") == ">=15 <16"
    assert game_range("") == "*"

    # fingerprint extraction + content addressing
    assert upstream_token("Team_Panel_TTaro_8757e120.zip") == "8757e120"
    assert upstream_token("East_Asia_Font_Pack_13.11.0.7z") is None
    assert is_content_addressed("pkg-8757e120.zip")
    assert is_content_addressed("pkg7-ab12cd34ef56.zip")
    assert not is_content_addressed("battle.panel.ttaro-part1.zip")

    def rec(slug, aid, tokens):
        return {"id": slug, "aslain_id": aid, "category": "battle",
                "version": "1", "game": ">=15.9 <15.10", "name_en": slug,
                "name_zh": "", "description": "", "author_url": "",
                "preview_urls": [], "loc_meta": {},
                "packages": [{"url": "u", "name": f"x_{t}.zip", "size_kb": 1,
                              "order": i, "token": t, "sha256": "", "size_bytes": 0,
                              "asset": f"pkg-{t}.zip"} for i, t in enumerate(tokens)],
                "total_kb": 1}

    def thread(slug, aid, names, version="1", closed=False, stale_reason=""):
        fm = (f"---\nwowsp-mod: {slug}\nversion: {version}\ngame: '*'\n"
              f"category: battle\n---")
        body = rewrite_front_matter(fm + "\n\nKEEP", fm)
        if stale_reason:
            body = rewrite_front_matter(body, fm, stale_reason, "2026-01-01", "v")
        return {"slug": slug, "number": 1, "id": "d", "title": "t", "body": body,
                "node": {"number": 1, "title": "t", "body": body, "closed": closed,
                         "author": {"login": "a"}, "comments": {"nodes": []}},
                "closed": closed, "fm": {"wowsp-mod": slug, "version": version},
                "version": version, "game": "*", "category": "battle",
                "aliases": [aid] if aid else [], "aslain_ids": [aid] if aid else [],
                "packages": [{"url": download_url(n), "sha256": "a" * 64,
                              "size": 1, "name": n} for n in names],
                "presets": [], "stale": parse_stale_block(body)}

    selection = {
        "content_version": "v.15.9.0 #05 (2026.10.22)", "version": "15.9.0.5",
        "game_version": "15.9.0", "game": ">=15.9 <15.10", "bin_max": "1",
        "mods": [
            rec("battle.panel.same", "UI_A", ["aa11bb22"]),
            rec("battle.panel.move", "UI_B", ["cc33dd44"]),
            rec("battle.panel.fresh", "UI_Fresh", ["12345678"]),
            rec("ui-fallbacknew", "UI_NoCurate", ["87654321"]),
        ],
        "catalog_ids": {"UI_A", "UI_B", "UI_Fresh", "UI_NoCurate",
                        "UI_Moved", "UI_Dis"},
        "disabled_ids": {"UI_Dis": "crashes"},
        "scope_ids": {"UI_A", "UI_B", "UI_Fresh", "UI_NoCurate"},
        "out_of_scope_ids": {"UI_Moved"},
    }
    threads = [
        thread("battle.panel.same", "UI_A", ["pkg-aa11bb22.zip"]),
        thread("battle.panel.move", "UI_B", ["pkg-00000000.zip"]),
        thread("battle.panel.dis", "UI_Dis", ["pkg-99999999.zip"]),
        thread("battle.panel.movedout", "UI_Moved", ["pkg-77777777.zip"]),
        thread("legacy.orphan", "Markers_Orphan", ["old-asset.zip"]),
        thread("voice.hand.made", "", ["voice.zip"]),
    ]
    plan = classify(selection, threads)

    def slugs(bucket):
        if not plan[bucket]:
            return set()
        first = plan[bucket][0]
        if "record" in first:
            return {e["record"]["id"] for e in plan[bucket]}
        return {t["slug"] for t in plan[bucket]}

    assert slugs("unchanged") == {"battle.panel.same"}, plan["unchanged"]
    assert slugs("changed") == {"battle.panel.move"}, plan["changed"]
    assert slugs("new") == {"battle.panel.fresh"}
    assert slugs("pending") == {"ui-fallbacknew"}
    assert {s["thread"]["slug"] for s in plan["stale"]} == {
        "battle.panel.dis", "battle.panel.movedout", "legacy.orphan"}, plan["stale"]
    assert set(plan["hand"]) == {"voice.hand.made"}
    dis = next(s["reason"] for s in plan["stale"] if s["thread"]["slug"] == "battle.panel.dis")
    assert dis.startswith("disabled upstream"), dis
    moved = next(s["reason"] for s in plan["stale"]
                 if s["thread"]["slug"] == "battle.panel.movedout")
    assert moved == "moved out of the ingested scope", moved
    gone = next(s["reason"] for s in plan["stale"] if s["thread"]["slug"] == "legacy.orphan")
    assert gone == "removed from the upstream catalog", gone

    # an entry back in scope must NOT be stale-marked
    selection["scope_ids"].add("UI_Moved")
    assert {s["thread"]["slug"] for s in classify(selection, threads)["stale"]} == {
        "battle.panel.dis", "legacy.orphan"}
    selection["scope_ids"].discard("UI_Moved")

    # a closed thread whose entry is in scope stays managed: refreshed like
    # any other entry, reported as closed_managed, never reopened
    threads.append(thread("battle.panel.same", "UI_A", ["pkg-aa11bb22.zip"], closed=True))
    plan3 = classify(selection, threads)
    assert "battle.panel.same" in {e["record"]["id"] for e in plan3["unchanged"]}
    assert "battle.panel.same" in plan3["closed_managed"]
    threads.pop()

    # legacy naming + sha-set comparison keeps the old version on byte-equality
    entry = {"record": rec("x", "X", ["aa11bb22"]),
             "thread": thread("x", "X", ["old-1.zip", "old-2.zip"]),
             "needs_download": True, "content_changed": None}
    entry["record"]["packages"][0]["sha256"] = "a" * 64
    assert resolve_content_changed(entry) is False
    entry["record"]["packages"][0]["sha256"] = "b" * 64
    assert resolve_content_changed(entry) is True

    # front-matter rewrite preserves the rest of the body and toggles the marker
    body = "---\nwowsp-mod: m\nversion: 1\ngame: '*'\ncategory: battle\n---\n\nKEEP ME"
    fm2 = "---\nwowsp-mod: m\nversion: 1\ngame: '>=15.9 <15.10'\ncategory: battle\n---"
    out = rewrite_front_matter(body, fm2, "removed", "2026-01-02", "v1")
    assert "KEEP ME" in out and "wowsp:sync-stale" in out and "2026-01-02" in out
    assert "Sync source closed" in out, "visible stale notice must ride the marker"
    out2 = rewrite_front_matter(out, fm2)
    assert "wowsp:sync-stale" not in out2 and "KEEP ME" in out2
    assert "Sync source closed" not in out2, "visible notice clears with the marker"
    assert rewrite_front_matter(out2, fm2) == out2  # idempotent

    # full rebuild regenerates download lines, keeps gallery + presets
    t = thread("battle.panel.same", "UI_A", ["pkg-aa11bb22.zip"])
    t["body"] = (t["body"] + "\n![pic](https://example.com/pic.jpg)\n"
                 "<!--\nwowsp:presets\na: A | A\nwowsp:presets\n-->\n"
                 "- [`a.zip`](https://github.com/langyo/wowsp/releases/download/mod-hub/a.zip)"
                 " — 1 KB · SHA-256 `" + "a" * 64 + "` · preset `a`\n")
    r = rec("battle.panel.same", "UI_A", ["aa11bb22"])
    r["packages"][0].update({"asset": "pkg-aa11bb22.zip", "sha256": "c" * 64, "size_bytes": 2048})
    nb = rebuild_body(r, t, "2", ">=15.9 <15.10", "", "v1")
    assert "pkg-aa11bb22.zip" in nb and ("c" * 64) in nb
    assert "https://example.com/pic.jpg" in nb and "wowsp:presets" in nb
    assert "preset `a`" in nb, "preset lines survive the rebuild"
    assert "catalog v1" in nb
    assert rebuild_body(r, t, "2", ">=15.9 <15.10", "", "v1") == nb

    # the asset gate: live entries shrink, delisted/stale entries are exempt
    def pkg(name):
        return {"url": download_url(name), "sha256": "a" * 64, "size": 1, "name": name}
    idx = {"mods": {
        "live": {"id": "live", "versions": {"1": {"game": "*", "packages": [
            pkg("ok.zip"), pkg("gone.zip")], "presets": []}}},
        "delisted": {"id": "delisted", "delisted": True, "versions": {"1": {
            "game": "*", "packages": [pkg("gone.zip")], "presets": []}}},
        "stale": {"id": "stale", "stale": {"reason": "r"}, "versions": {"1": {
            "game": "*", "packages": [pkg("gone.zip")], "presets": []}}},
    }}
    dropped, total = gate_index(idx, {"ok.zip"})
    assert (dropped, total) == (1, 2), (dropped, total)
    assert [p["name"] for p in idx["mods"]["live"]["versions"]["1"]["packages"]] == ["ok.zip"]
    assert len(idx["mods"]["delisted"]["versions"]["1"]["packages"]) == 1
    assert len(idx["mods"]["stale"]["versions"]["1"]["packages"]) == 1

    # the report renderer handles both full and index-only shapes
    report = build_report("detect", selection, threads, plan, time.time() - 3, True)
    text = render_summary(report)
    assert "Mod Hub sync report" in text and "pending" in text
    assert "index-only" in render_summary({"mode": "index-only", "ran_at": now_iso(),
                                           "duration_s": 1, "upstream": {}, "counts": {},
                                           "changed": [], "stale": [], "pending": [],
                                           "new_published": [],
                                           "actions": {}, "warnings": []})

    # shared-runtime bundling: RequiresAny attach + the visible runtime note
    dep = rec("battle.timer.clock", "UI_Timers_BattleClock", ["8be69ddb"])
    implicit = [{"url": "u-imp", "name": "Implicit_modforge_729863db.zip",
                 "size_kb": 125, "order": 0, "token": "729863db", "sha256": "",
                 "size_bytes": 0, "asset": "",
                 "requires_any": ["UI_Timers_BattleClock", "UI_NotSelected"]}]
    assert bundle_implicit_packages([dep], implicit) == 1
    assert dep["requires_runtime"] is True
    assert dep["packages"][-1]["token"] == "729863db"
    assert bundle_implicit_packages([dep], implicit) == 0  # re-bundling: no-op
    # the excluded OlliN ShipIdentity implicit never reaches dependents
    dep_si = rec("battle.timer.clock2", "UI_Timers_BattleClock2", ["8be69ddb"])
    implicit_si = [{"url": "u-si", "name": "Implicit_portmods_shipidentity_4d41c0e7.zip",
                    "size_kb": 150, "order": 0, "token": "4d41c0e7", "sha256": "",
                    "size_bytes": 0, "asset": "",
                    "requires_any": ["UI_Timers_BattleClock2"]}]
    assert bundle_implicit_packages([dep_si], implicit_si) == 0
    assert "requires_runtime" not in dep_si
    assert all("shipidentity" not in p["name"].lower() for p in dep_si["packages"])
    dep["packages"][0].update({"asset": "pkg-8be69ddb.zip", "sha256": "d" * 64,
                               "size_bytes": 2048})
    dep["packages"][-1].update({"asset": "pkg-729863db.zip", "sha256": "e" * 64,
                                "size_bytes": 128000})
    nb = rebuild_body(dep, None, "2", ">=15.9 <15.10", "", "v1")
    assert "shared runtime package" in nb and "pkg-729863db.zip" in nb

    # version-level bundled entries survive the gate without packages
    idx["mods"]["stats"] = {"id": "stats", "versions": {"1": {
        "game": "*", "packages": [], "bundled": True, "presets": []}}}
    gate_index(idx, {"ok.zip"})
    assert "stats" in idx["mods"] and idx["mods"]["stats"]["versions"]

    # sync policies: split + stale exemption for skipped ids
    m_auto = rec("battle.panel.same", "UI_A", ["aa11bb22"])
    m_man = rec("ui.achievement.held", "UI_Held", ["bb22cc33"])
    m_skip = rec("battle.panel.gone", "UI_Skip", ["cc33dd44"])
    kept, manual_ids, skipped_ids = apply_policies(
        [m_auto, m_man, m_skip],
        {"ui.achievement.held": "manual", "battle.panel.gone": "skip"})
    assert [m["id"] for m in kept] == ["battle.panel.same", "ui.achievement.held"]
    assert manual_ids == ["ui.achievement.held"] and skipped_ids == ["UI_Skip"]
    assert m_auto["policy"] == "auto" and m_man["policy"] == "manual"
    sel_p = dict(selection)
    sel_p["mods"] = [m_auto]
    sel_p["scope_ids"] = {"UI_A"}
    sel_p["policy_skipped_ids"] = {"Markers_Orphan"}
    assert classify(sel_p, [thread("legacy.orphan", "Markers_Orphan", ["old-asset.zip"])])["stale"] == []

    # apply --reaudit: promote unchanged live entries into the download+audit
    # lane (one-shot guard migration) while manual-policy ones stay held
    plan_r = {"unchanged": [{"record": m_auto}, {"record": m_man}],
              "changed": [], "new": []}
    assert promote_reaudit(plan_r) == 1
    assert [e["record"]["id"] for e in plan_r["changed"]] == ["battle.panel.same"]
    assert plan_r["changed"][0]["needs_download"] is True
    assert plan_r["changed"][0]["reason"] == "content re-audit (--reaudit)"
    assert [e["record"]["id"] for e in plan_r["unchanged"]] == ["ui.achievement.held"]

    # package content gate (shared mod_package_check helpers): the scan
    # names corrupt .swf members and records unresolvable glue refs --
    # run_apply turns the former into a hard SystemExit and the latter
    # into report warnings.
    import io as _io
    import zipfile as _zipfile

    def _zbytes(members: dict) -> bytes:
        buf = _io.BytesIO()
        with _zipfile.ZipFile(buf, "w") as z:
            for name, data in members.items():
                z.writestr(name, data)
        return buf.getvalue()

    rep = mod_package_check.scan_bytes(_zbytes({
        "gui/uss_settings.xml": '<swffile>gui/unbound/mods/gone.swf</swffile>',
        "gui/unbound/mods/here.swf": b"CWS\x06\x00",
    }), "pkg.zip")
    assert rep.swf_members_ok == 1 and not rep.bad_swf_members, rep
    assert [f.ref_basename for f in rep.findings] == ["gone.swf"], rep.findings
    assert rep.findings[0].referencing_members == ["gui/uss_settings.xml"]

    # content-based package-set guard: a filename regex cannot catch
    # component-variant carriers that re-bundle the raw OlliN ShipIdentity
    # template under unrelated names (the live 2026-11-06/07 assets), so the
    # sync audits the zips themselves before anything is staged.
    import zlib as _zlib

    template_rel = "res_mods/gui/unbound2/!shipidentity/ShipIdentity.unbound"
    normal_rel = "res_mods/gui/unbound2/other.xml"

    # package_entries(): (name, size, CRC-32) round-trip of an in-memory zip
    entries = package_entries(_zbytes({template_rel: b"template-bytes",
                                       normal_rel: b"<x/>"}))
    assert entries == [
        (template_rel, len(b"template-bytes"), _zlib.crc32(b"template-bytes")),
        (normal_rel, len(b"<x/>"), _zlib.crc32(b"<x/>")),
    ], entries

    def _pkg(name, members):
        return name, package_entries(_zbytes(members))

    # both ShipIdentity variants are excluded; the functional package is kept
    normal_pkg = _pkg("pkg-normal.zip", {normal_rel: b"<x/>"})
    kept, excluded, audit_warnings = audit_package_set([
        _pkg("pkg-fba8f907.zip", {template_rel: b"# reduced: no macro"}),
        normal_pkg,
        _pkg("pkg-3d9a010e.zip", {template_rel: b"# complete: macro defined"}),
    ])
    assert audit_warnings == [], audit_warnings
    assert kept == [1], kept
    assert len(excluded) == 2, excluded
    assert excluded == [SHIP_IDENTITY_EXCLUDE_REASON] * 2, excluded
    assert "#1634" in excluded[0], excluded[0]

    # template mixed into functional payload refuses to publish
    try:
        audit_package_set([_pkg("pkg-mixed.zip",
                                {template_rel: b"t", normal_rel: b"<x/>"})])
    except ValueError as exc:
        assert "mixed with functional payload" in str(exc), exc
    else:
        raise AssertionError("a mixed ShipIdentity package must refuse to publish")

    # conflicting duplicate target (same path, different bytes): the live
    # catalog carries real cases (battle.monitor.afk, battle.marker.consumables),
    # so publishing proceeds with both packages and a warning; the app's install
    # merge keeps the first copy deterministically. Hard-failing here would make
    # the content-guard migration (apply --reaudit) impossible on live data.
    kept, excluded, audit_warnings = audit_package_set([
        ("pkg-a.zip", [("res_mods/gui/shared.xml", 4, 111)]),
        ("pkg-b.zip", [("res_mods/GUI/Shared.xml", 4, 222)]),
    ])
    assert kept == [0, 1] and excluded == [], (kept, excluded)
    assert len(audit_warnings) == 1, audit_warnings
    assert "legacy duplicate target" in audit_warnings[0], audit_warnings[0]
    assert "res_mods/GUI/Shared.xml" in audit_warnings[0], audit_warnings[0]
    assert "pkg-a.zip" in audit_warnings[0] and "pkg-b.zip" in audit_warnings[0], audit_warnings[0]

    # byte-identical duplicate target = shared-runtime dedupe, accepted silently
    kept, excluded, audit_warnings = audit_package_set([
        ("pkg-a.zip", [("res_mods/gui/shared.xml", 4, 111)]),
        ("pkg-b.zip", [("res_mods/GUI/Shared.xml", 4, 111)]),
    ])
    assert kept == [0, 1] and excluded == [] and audit_warnings == [], \
        (kept, excluded, audit_warnings)

    # package hygiene: the publish-side twin of the app's preview/screenshot
    # filter runs at download time (no served asset may carry promo material);
    # the predicate's own truth table rides its selftest.
    mod_package_hygiene.selftest()
    print("selftest ok")


# ---------------------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="stage", required=True)

    def common(p):
        p.add_argument("--repo", default=REPO)
        p.add_argument("--cache-dir",
                       default=str(Path(tempfile.gettempdir()) / "wowsp-modhub-sync"))
        p.add_argument("--json", help="write the machine-readable report here")

    common(sub.add_parser("detect", help="read-only: fetch upstream, diff against live threads"))
    aply = sub.add_parser("apply", help="the real sync (assets, threads, index, GC)")
    common(aply)
    aply.add_argument("--dry-run", action="store_true",
                      help="plan + would-be actions, no downloads or writes")
    aply.add_argument("--include-new", action="store_true",
                      help="publish new entries whose slugs are curated")
    aply.add_argument("--no-gc", action="store_true", help="skip unreferenced-asset pruning")
    aply.add_argument("--reaudit", action="store_true",
                      help="force a download + content-guard audit of every in-scope "
                           "entry once (run after changing the package content guard)")
    idx = sub.add_parser("index-only", help="re-crawl threads and republish mod-index.json")
    common(idx)
    common(sub.add_parser("render-summary", help="print the markdown summary of a report json"))
    issue = sub.add_parser("issue", help="create/overwrite one open issue from --body-file")
    issue.add_argument("--title", required=True)
    issue.add_argument("--body-file", required=True)
    sub.add_parser("selftest", help="offline checks")

    args = ap.parse_args(argv)
    if args.stage == "selftest":
        return selftest() or 0
    if args.stage == "render-summary":
        report = json.loads(Path(args.json).read_text(encoding="utf-8")) if args.json else \
            json.loads(sys.stdin.read())
        print(render_summary(report))
        return 0
    if args.stage == "issue":
        body = Path(args.body_file).read_text(encoding="utf-8")
        ensure_issue(args.title, body)
        return 0
    if args.stage == "detect":
        return run_detect(args)
    if args.stage == "apply":
        return run_apply(args)
    if args.stage == "index-only":
        return run_index_only(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
