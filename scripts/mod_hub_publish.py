#!/usr/bin/env python3
"""Mod Hub bulk publisher: ingest tool-type mods from Aslain's WoWs Modpack.

The Aslain catalog is used once, offline, as the ingestion source. Packages are
re-hosted as assets of the ``mod-hub`` release on this repository, and each mod
gets one Discussions thread carrying the ``wowsp-mod`` front-matter (same
template as docs/en/designs/mod-hub.md §2) plus per-package SHA-256 hashes and
download links. ``scripts/mod_index.py`` can then crawl the threads into
``mod-index.json``; this script also emits and uploads the index directly so
the app does not have to wait for a crawl.

Stages (all idempotent, run them in order):

    python scripts/mod_hub_publish.py curate      # Aslain catalog -> curated.json
    python scripts/mod_hub_publish.py download    # packages -> cache + hashes
    python scripts/mod_hub_publish.py previews    # preview jpgs -> user-attachment urls
    python scripts/mod_hub_publish.py release     # ensure mod-hub release + upload zips
    python scripts/mod_hub_publish.py discussions # one thread per mod (skips existing)
    python scripts/mod_hub_publish.py enrich      # rewrite live threads: aliases, rich
                                                  # descriptions, screenshot galleries
    python scripts/mod_hub_publish.py update-bodies  # re-emit thread download lines
                                                  # (run after a repack/drop healing pass
                                                  # so threads carry the new hashes)
    python scripts/mod_hub_publish.py index       # emit + upload mod-index.json
    python scripts/mod_hub_publish.py selftest    # offline checks (no network)

    python scripts/mod_hub_publish.py curate --dry-run   # just print the selection

No third-party deps. Requires the ``gh`` CLI (authenticated, repo scope) and
network access to repo.aslain.com and github.com.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

# Sibling module (same directory — sys.path[0] when run as
# `python scripts/mod_hub_publish.py`).
import publish_digests

REPO = "langyo/wowsp"
ROOT_URL = "https://repo.aslain.com/wows_modmanager/root.xml"
RELEASE_TAG = "mod-hub"
RELEASE_TITLE = "Mod Hub package store"
UA = "wowsp-mod-hub-publisher/1.0"

# Categories worth carrying into the hub: strong-tool content only. Skins,
# crosshairs, sounds, flags, theme packs, camera/tweak patches (action-only on
# the Aslain side) and standalone external apps are deliberately left out.
INCLUDE_CATEGORIES = {
    "Team_Panel",
    "Team_Mini_Panel",
    "Minimap",
    "Chat",
    "UI",
    "Markers",
    "Port_mods",
    "texts",
}
# Cosmetic or removal-only entries inside those categories.
EXCLUDE_MODS = {
    # minimap image swaps
    "Minimap_Fading",
    # de-skin / removal patches
    "Team_Mini_Panel_Remove",
    "Port_mods_LootBox_Crane_Remover",
    # flag & crew art, port cosmetics
    "Port_mods_NationFlags",
    "Port_mods_OriginFlags",
    "Port_mods_PanAsianCrew",
    "Port_mods_MainCrew_v1",
    "Port_mods_MainCrew_v2",
    "Port_mods_CommanderCrew_Kancolles_Admiral",
    "Port_mods_CommanderCrew_Lady_Miranda_Nvai",
    "Port_mods_CommanderCrew_MermaidsWrath",
    "Port_mods_CommanderCrew_HistoricalUniqueCommanders",
    "Port_mods_CommanderCrew_Fanhexie",
    "Port_mods_CommanderCrew_Dasha_in_the_Navy",
    "Port_mods_Permanent_Karmaflage",
    "Port_mods_No_funnel_smoke_in_port",
    "Port_mods_commander_perks_colored_vito78m",
}
# Discussion-level localization: an invisible HTML comment that carries the
# name + one-line description in every supported locale. The indexer and the
# app both parse the raw body, so the block doubles as the machine-readable
# translation source. Missing locales fall back to en-US on the consumer side.
I18N_LOCALES = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "de-DE", "fr-FR", "es-ES"]


def build_i18n_block(i18n: dict) -> str:
    """Render the hidden <!-- wowsp:i18n ... --> localization block."""
    lines = ["<!--", "wowsp:i18n"]
    for lang in I18N_LOCALES:
        entry = (i18n or {}).get(lang) or {}
        name = entry.get("name", "")
        desc = " ".join(entry.get("desc", "").split())
        lines.append(f"{lang}: {name} | {desc}".rstrip(" |"))
    lines.append("wowsp:i18n")
    lines.append("-->")
    return "\n".join(lines)


def thread_title(mod: dict) -> str:
    """Thread titles are English-only; localized names live in the i18n
    block and the collapsed description section."""
    return f"[Mod] {mod['name_en']} {mod['id']} {mod['version']}"


def build_i18n_details(i18n: dict) -> str:
    """Visible collapsed section listing the description in every locale."""
    lines = ["<details>", f"<summary>📖 Description in {len(I18N_LOCALES)} languages</summary>", ""]
    for lang in I18N_LOCALES:
        entry = (i18n or {}).get(lang) or {}
        name = entry.get("name", "")
        desc = " ".join(entry.get("desc", "").split())
        if not name and not desc:
            continue
        label = f"**{name}**" if name else ""
        body = f": {desc}" if desc else ""
        lines.append(f"- **`{lang}`** {label}{body}".replace("  ", " "))
    lines.append("")
    lines.append("</details>")
    return "\n".join(lines)


I18N_LOCALE_RE = re.compile(r"^([a-z]{2,3}-[A-Za-z]{2,4}):\s*(.+)$")


def parse_i18n_block(body: str) -> dict:
    """Read the wowsp:i18n block back out of a raw discussion body (same
    locale grammar as the indexer's parse_i18n — BCP-47-ish tags, not URLs)."""
    m = re.search(r"wowsp:i18n\n(.*?)\nwowsp:i18n", body or "", re.DOTALL)
    if not m:
        return {}
    out: dict = {}
    for line in m.group(1).splitlines():
        loc = I18N_LOCALE_RE.match(line.strip())
        if not loc:
            continue
        name, _, desc = loc.group(2).partition("|")
        out[loc.group(1)] = {"name": name.strip(), "desc": desc.strip()}
    return out


# Slug migration table: legacy ingest ids -> taxonomical slugs
# (category.genus.species). Maintained in scripts/mod_hub_slugs.py; curate
# consults it so future Aslain refreshes land on the same names.
from mod_hub_slugs import CATEGORY_RENAME, SLUG_MAP  # noqa: E402 - repo-local

# Repository-curated per-locale descriptions for every catalog entry
# (scripts/mod_hub_desc_i18n.json) — Aslain only ships rich descriptions in
# a couple of languages, so the remaining locales are curated here and laid
# over each thread by `enrich` as the HIGHEST-priority layer. The reserved
# "_names" entry carries per-locale NAME FIXES that OVERRIDE the live block
# and Aslain's own metadata (attribution stays out of display names; e.g.
# es-ES names for hand-published threads outside the Aslain ingest).
_DESC_I18N_PATH = Path(__file__).with_name("mod_hub_desc_i18n.json")
DESC_I18N: dict = (
    json.loads(_DESC_I18N_PATH.read_text(encoding="utf-8"))
    if _DESC_I18N_PATH.exists()
    else {}
)
DESC_I18N_NAMES: dict = DESC_I18N.pop("_names", {}) if DESC_I18N else {}

# Author tag registry (scripts/mod_hub_authors.json): `mods` maps every
# catalog slug to its author's display name and `authors` maps that name to
# the author's official page (empty string = no verified page, the tag then
# renders without a link). `enrich` writes both into the thread's
# front-matter (`author:` / `author_url:`) and `index` copies them into
# mod-index.json; the catalog UI renders them as the clickable author tag.
_AUTHORS_PATH = Path(__file__).with_name("mod_hub_authors.json")
MOD_AUTHORS: dict = (
    json.loads(_AUTHORS_PATH.read_text(encoding="utf-8"))
    if _AUTHORS_PATH.exists()
    else {}
)


def author_record(slug: str) -> list[tuple[str, str]]:
    """(name, official page) for every author of one catalog slug, from the
    registry — multi-author mods carry one pair each, in attribution order."""
    names = MOD_AUTHORS.get("mods", {}).get(slug) or []
    if isinstance(names, str):
        names = [names]
    return [(n, MOD_AUTHORS.get("authors", {}).get(n, "")) for n in names if n]


def append_author_lines(front: list[str], slug: str) -> None:
    """The front-matter author tag: one comma-separated `authors:` line; the
    crawler resolves each name to its official page through the registry."""
    pairs = author_record(slug)
    if pairs:
        front.append(f"authors: {', '.join(name for name, _ in pairs)}")

CATEGORY_MAP = {
    "Team_Panel": "battle",
    "Team_Mini_Panel": "battle",
    "UI": "battle",
    "Markers": "battle",
    "Minimap": "minimap",
    "Port_mods": "port",
    "Chat": "texts",
    "texts": "texts",
}


# Aslain-side names that no display-name similarity tier can bridge — the
# modpack's manifest row ids and the on-disk directory names its packages
# write. Each list is emitted as the discussion's `aliases:` front-matter,
# harvested into mod-index.json, and treated by the app as EXACT pairing
# identity (see foreign.rs `entry_name_forms`). Verified against a live
# Aslain 4.3.1 install; the ingest's `aslain_id` is appended automatically
# so plain row ids need no entry here.
ASLAIN_ALIASES: dict[str, list[str]] = {
    "battle.timer.clock": ["BADoBEST_BattleClock"],
    "battle.marker.torpedo-spotted": ["BattleFrame_TorpedoDetection", "BattleFrame_Torpedoes"],
    "port.crew.counter": ["CrewCounter"],
    "port.population.server": ["Port_Interface_ServerPopulation"],
    "battle.minipanel.team-hp": ["TeamHP"],
    "minimap.rpf.2d": ["TwoDimentionalRadio"],
    "minimap.ping.submarine": ["MinimapSubPingerPy"],
    "battle.hydro.3d": ["ThreeDimentionalHydro"],
    "battle.radar.3d": ["ThreeDimentionalRadar"],
    "battle.rpf.3d": ["ThreeDimentionalRadio"],
    "battle.impact-angle.all": ["VisibleAngleOfImpact_Enemy"],
    "battle.marker.consumables": ["ConsumablesMonitor2Py"],
    "battle.marker.torpedo-advanced": ["AdvancedTorpedoMarkerPy"],
    "battle.marker.regen": ["RegenMonitorPy"],
    "battle.marker.smoke": ["SmokeMarkerPy"],
    "battle.build.viewer": ["BuildViewerPy"],
    "battle.module.viewer": ["ModuleStateViewerPy"],
    "battle.calculator.penetration": ["PenetrationCalculatorPy"],
}

# Entry-level category corrections applied by `enrich` regardless of what
# curate knows (hand-published threads are outside the Aslain ingest).
# The Azur Lane ribbons pack is an interface skin, not a ship model — the
# only live `skin` miscategorization today.
CATEGORY_OVERRIDE: dict[str, str] = {
    "skin.ribbon.azur-lane": "ui",
}


def aliases_of(mod: dict) -> list[str]:
    """Every Aslain-side name an entry answers to: the curated table plus
    the raw Aslain Mod Id (manifest rows carry it verbatim), deduped,
    order-stable."""
    out = list(ASLAIN_ALIASES.get(mod["id"], []))
    aslain_id = mod.get("aslain_id") or ""
    if aslain_id and aslain_id not in out:
        out.append(aslain_id)
    return out


def gh(*args: str, input_text: str | None = None) -> str:
    cmd = ["gh", "api", *args]
    if input_text is not None:
        cmd += ["--input", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode != 0:
        raise RuntimeError(f"gh api failed: {out.stderr.strip()[:500]}")
    return out.stdout


def gh_graphql(query: str, **fields) -> dict:
    # Object-typed variables (CreateDiscussionInput) only survive as real
    # objects when the whole request goes through as JSON on stdin.
    payload = json.dumps({"query": query, "variables": fields})
    last_err = ""
    for attempt in range(1, 4):
        out = subprocess.run(
            ["gh", "api", "graphql", "--input", "-"],
            input=payload, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
        )
        if out.returncode == 0:
            return json.loads(out.stdout)["data"]
        last_err = out.stderr.strip()[:500]
        if "dial tcp" in last_err or "timed out" in last_err or "Could not resolve" in last_err:
            time.sleep(3 * attempt)
            continue
        break
    raise RuntimeError(f"gh api graphql failed: {last_err}")


def resolve_url(base: str, relative: str) -> str:
    """Mirror CatalogService.Combine for http bases (../Files/... style)."""
    path = relative.replace("\\", "/")
    if "://" in path:
        return path
    scheme, sep, rest = base.rstrip("/").partition("://")
    if not sep:
        return posixpath.normpath(posixpath.join(base, path))
    # normpath would collapse the "//" in the scheme, so stitch it back on.
    joined = posixpath.normpath(posixpath.join(rest, path))
    return f"{scheme}://{joined}"


def slugify(mod_id: str) -> str:
    return re.sub(r"_+", "-", mod_id.strip("_")).lower()


def catalog_version(content_version: str) -> str:
    """'v.15.7.0 #10 (2026.08.30)' -> '15.7.0.10' (sortable, index latest= logic)."""
    m = re.match(r"v\.(\d+(?:\.\d+){1,3})\s*#(\d+)", content_version or "")
    if not m:
        return "0"
    return f"{m.group(1)}.{m.group(2)}"


def fetch_binary(url: str, dest: Path, retries: int = 3) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            if len(data) == 0:
                raise RuntimeError("empty response")
            dest.write_bytes(data)
            return dest
        except Exception as exc:  # noqa: BLE001 - retry any transport error
            if attempt == retries:
                raise
            print(f"  retry {attempt}/{retries - 1} for {url}: {exc}", flush=True)
            time.sleep(2 * attempt)
    raise RuntimeError("unreachable")


# ------------------------------------------------------------ archive sanity

# The app's installer only understands zip containers; a package whose
# bytes are anything else installs as a hard failure at the user's end
# (the live catalog once carried a `.zip` that was really a 7z). The
# download stage therefore checks the magic of every payload.
ZIP_MAGICS = (b"PK\x03\x04", b"PK\x05\x06")  # local-file header / empty archive
SEVENZ_MAGIC = b"7z\xbc\xaf\x27\x1c"

# Where to look for a 7z extractor when a payload needs repacking: PATH
# first (7z / 7zz on Linux and macOS), then the standard Windows installs.
SEVENZ_CANDIDATES = (
    "7z",
    "7zz",
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
)


def sevenz_binary() -> str | None:
    for cand in SEVENZ_CANDIDATES:
        found = shutil.which(cand)
        if found:
            return found
        direct = Path(cand)
        if direct.is_file():
            return str(direct)
    return None


def looks_like_zip(data: bytes) -> bool:
    return data.startswith(ZIP_MAGICS)


def rezip_sevenz(src: Path, binary: str) -> bytes:
    """Extract one 7z archive and repack its file tree as a real zip.

    The catalog payload keeps the same inner layout (the app installs
    `res_mods/…` trees); only the container changes, so the sha256 and
    size the index publishes are the zip's.
    """
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp) / "x"
        subprocess.run(
            [binary, "x", "-y", f"-o{out_dir}", str(src)],
            check=True, capture_output=True,
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(out_dir.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(out_dir).as_posix())
        return buf.getvalue()


# ---------------------------------------------------------------- curate


def curate(cache: Path, dry_run: bool = False) -> list[dict]:
    root = ET.fromstring(fetch_binary(ROOT_URL, cache / "root.xml").read_bytes())
    caches = {
        c.attrib["Version"]: c.attrib["Url"]
        for c in root.iter("Cache")
        if c.attrib.get("Version") and c.attrib.get("Url")
    }
    game_version = max(caches, key=lambda v: [int(x) for x in v.split(".") if x.isdigit()])
    base_url = caches[game_version]
    bin_max = (root.findtext("MaxGameBin") or "").strip()

    cfg = ET.fromstring(fetch_binary(f"{base_url}/Configuration", cache / "Configuration").read_bytes())
    loc_root = ET.fromstring(fetch_binary(f"{base_url}/Localizations", cache / "Localizations").read_bytes())
    locs: dict[str, dict[str, dict[str, str]]] = {}
    for item in loc_root.iter("Item"):
        entry: dict[str, dict[str, str]] = {}
        for loc in item.iter("Loc"):
            entry[loc.attrib.get("Lang", "")] = dict(loc.attrib)
        locs[item.attrib["Id"]] = entry

    content_version = cfg.attrib.get("ContentVersion", "")
    version = catalog_version(content_version)
    mods: list[dict] = []
    for cat in cfg.iter("Category"):
        cid = cat.attrib.get("Id", "")
        if cid not in INCLUDE_CATEGORIES:
            continue
        for mod in cat.iter("Mod"):
            mid = mod.attrib.get("Id", "")
            if mid in EXCLUDE_MODS:
                continue
            packages = []
            pkg_els = mod.findall("Package")
            if mod.attrib.get("File"):
                pkg_els = [mod] + pkg_els  # File= on the Mod itself acts as package #0
            for order, pkg in enumerate(pkg_els):
                file_attr = pkg.attrib.get("File", "") if pkg is not mod else mod.attrib["File"]
                if not file_attr:
                    continue
                size = int(pkg.attrib.get("SizeKb", "0") or 0)
                packages.append(
                    {
                        "url": resolve_url(base_url, file_attr),
                        "name": posixpath.basename(file_attr.replace("\\", "/")),
                        "size_kb": size,
                        "order": order,
                    }
                )
            if not packages or all(p["size_kb"] == 0 for p in packages):
                continue  # action-only patches stay native to WoWSP, not published
            meta = locs.get(mid, {})
            en = meta.get("en-US", {})
            zh = meta.get("zh-CN", {})
            # Preview carries one OR MORE `|`-separated screenshots.
            previews = [resolve_url(base_url, part) for part in (mod.attrib.get("Preview") or "").split("|") if part.strip()]
            loc_meta = {
                lang: {"name": (a.get("Name") or "").strip(), "desc": re.sub(r"\s+", " ", a.get("Description") or "").strip()}
                for lang, a in meta.items()
            }
            mods.append(
                {
                    "id": SLUG_MAP.get(slugify(mid), slugify(mid)),
                    "aslain_id": mid,
                    "category": CATEGORY_RENAME.get(CATEGORY_MAP[cid], CATEGORY_MAP[cid]),
                    "aslain_category": cid,
                    "version": version,
                    "game": ">=15.7 <15.8",
                    "bin_max": bin_max,
                    "name_en": en.get("Name") or mid,
                    "name_zh": zh.get("Name") or "",
                    "description": re.sub(r"\s+", " ", en.get("Description") or "").strip(),
                    "author_url": mod.attrib.get("AuthorUrl", ""),
                    "preview_url": previews[0] if previews else "",
                    "preview_urls": previews,
                    "loc_meta": loc_meta,
                    "packages": packages,
                    "total_kb": sum(p["size_kb"] for p in packages),
                }
            )
    mods.sort(key=lambda m: (m["category"], m["aslain_id"]))
    print(
        f"catalog {content_version} (game {game_version}, bin {bin_max}): "
        f"{len(mods)} mods, {sum(m['total_kb'] for m in mods) / 1024:.1f} MB"
    )
    for m in mods:
        print(f"  [{m['category']:7}] {m['id']:44} {m['total_kb']:>7} KB  {m['name_en']}")
    if dry_run:
        return mods
    (cache / "curated.json").write_text(
        json.dumps({"content_version": content_version, "game_version": game_version, "mods": mods}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return mods


def load_state(cache: Path) -> dict:
    path = cache / "curated.json"
    if not path.exists():
        sys.exit("curated.json missing - run `curate` first")
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- download


def sidecar_key(mod_id: str, pkg_name: str) -> str:
    """The repacked sidecar's key: mods may share package basenames."""
    return f"{mod_id}/{pkg_name}"


def download(cache: Path) -> None:
    state = load_state(cache)
    pkgs_dir = cache / "packages"
    # Names repacked from 7z in an earlier run (their bytes are cached as
    # zips now, but Aslain's catalog size still describes the 7z — the
    # sidecar keeps the size-drift warning from firing on every re-run).
    repacked_path = cache / "repacked.json"
    repacked_names: set[str] = set()
    if repacked_path.exists():
        repacked_names = set(json.loads(repacked_path.read_text(encoding="utf-8")))
    done = 0
    dropped = 0
    for mod in state["mods"]:
        kept_packages = []
        for pkg in mod["packages"]:
            dest = pkgs_dir / mod["id"] / pkg["name"]
            if dest.exists() and dest.stat().st_size > 0:
                data = dest.read_bytes()
            else:
                print(f"GET {pkg['url']}", flush=True)
                data = fetch_binary(pkg["url"], dest).read_bytes()
            # The installer only speaks zip; a mislabeled container would
            # surface as a user-facing install failure (the live catalog
            # once carried a 7z under a .zip name). Repack what can be
            # repacked, drop the rest before it reaches any index.
            repacked = False
            if not looks_like_zip(data):
                if data.startswith(SEVENZ_MAGIC):
                    binary = sevenz_binary()
                    if binary:
                        try:
                            data = rezip_sevenz(dest, binary)
                        except (subprocess.CalledProcessError, OSError) as exc:
                            detail = getattr(exc, "stderr", None) or b""
                            if isinstance(detail, bytes):
                                detail = detail.decode("utf-8", errors="replace")
                            tail = str(detail).strip()[-200:]
                            print(f"  WARN dropping {pkg['name']}: 7z repack failed"
                                  f"{f' ({tail})' if tail else f' ({exc})'}", file=sys.stderr, flush=True)
                            dropped += 1
                            continue
                        dest.write_bytes(data)
                        repacked = True
                        repacked_names.add(sidecar_key(mod["id"], pkg["name"]))
                        # Persist immediately: an interrupted run must not
                        # lose the entry (the cache already serves the zip,
                        # so a later run could never re-derive it).
                        repacked_path.write_text(
                            json.dumps(sorted(repacked_names), indent=1), encoding="utf-8")
                        print(f"  repacked 7z->zip: {pkg['name']} ({len(data) // 1024} KB)", flush=True)
                    else:
                        print(f"  WARN dropping {pkg['name']}: 7z container and no 7z binary on this machine",
                              file=sys.stderr, flush=True)
                        dropped += 1
                        continue
                else:
                    print(f"  WARN dropping {pkg['name']}: not a zip archive "
                          f"(magic {data[:6].hex()})", file=sys.stderr, flush=True)
                    dropped += 1
                    continue
            pkg["sha256"] = hashlib.sha256(data).hexdigest()
            pkg["size_bytes"] = len(data)
            # Aslain's size describes the original container; a repacked
            # zip naturally differs, so only compare untouched payloads
            # (the sidecar remembers earlier repacks across runs).
            if (
                not repacked
                and sidecar_key(mod["id"], pkg["name"]) not in repacked_names
                and pkg["size_kb"]
                and abs(len(data) // 1024 - pkg["size_kb"]) > max(2, pkg["size_kb"] // 2)
            ):
                print(f"  WARN size drift for {pkg['name']}: catalog {pkg['size_kb']} KB, got {len(data) // 1024} KB")
            kept_packages.append(pkg)
            done += 1
        mod["packages"] = kept_packages
    # Mods whose every package was dropped leave the catalog entirely —
    # the index stops referencing them (the release keeps now-orphaned
    # asset copies until someone prunes them; nothing serves those to
    # users once the index no longer lists them).
    before = len(state["mods"])
    state["mods"] = [m for m in state["mods"] if m["packages"]]
    if len(state["mods"]) != before:
        print(f"dropped {before - len(state['mods'])} mods with no remaining packages",
              file=sys.stderr, flush=True)
    (cache / "downloaded.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{done} packages downloaded & hashed, {dropped} dropped -> {pkgs_dir}")


def downloaded_state(cache: Path) -> dict:
    path = cache / "downloaded.json"
    if not path.exists():
        sys.exit("downloaded.json missing - run `download` first")
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- previews


def upload_user_attachment(data: bytes, name: str, content_type: str, repo_id: str) -> str:
    """Upload a media file via the undocumented user-attachments endpoint.

    Only image/video content types are accepted there - zip payloads cannot be
    attached to discussions through the API, which is why mod packages ride on
    the mod-hub release instead.
    """
    req = urllib.request.Request(
        f"https://uploads.github.com/user-attachments/assets?name={urllib.parse.quote(name)}"
        f"&content_type={urllib.parse.quote(content_type)}&repository_id={repo_id}",
        data=data,
        method="POST",
        headers={"Authorization": f"Bearer {token()}", "Accept": "application/json", "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read())
    url = out.get("url") or out.get("href") or ""
    if not url.startswith("https://"):
        raise RuntimeError(f"unexpected upload response: {str(out)[:200]}")
    return url


_TOKEN: str | None = None


def token() -> str:
    global _TOKEN
    if _TOKEN is None:
        _TOKEN = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True,
            encoding="utf-8", errors="replace",
        ).stdout.strip()
    return _TOKEN


def previews(cache: Path) -> None:
    state = downloaded_state(cache)
    repo_id = json.loads(gh(f"repos/{REPO}"))["id"]
    ok = 0
    for mod in state["mods"]:
        if not mod["preview_url"]:
            continue
        dest = cache / "previews" / f"{mod['id']}.jpg"
        try:
            if dest.exists():
                data = dest.read_bytes()
            else:
                data = fetch_binary(mod["preview_url"], dest).read_bytes()
            mod["preview_attachment"] = upload_user_attachment(data, f"{mod['id']}.jpg", "image/jpeg", str(repo_id))
            ok += 1
            print(f"  preview {mod['id']} -> {mod['preview_attachment']}", flush=True)
        except Exception as exc:  # noqa: BLE001 - previews are best-effort
            print(f"  preview {mod['id']} FAILED: {exc}", flush=True)
            mod["preview_attachment"] = ""
        time.sleep(0.3)
    (cache / "downloaded.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{ok} previews uploaded")


# ---------------------------------------------------------------- release


def release(cache: Path) -> None:
    state = downloaded_state(cache)
    # The release must exist before uploading; --clobber keeps re-runs cheap.
    out = subprocess.run(
        ["gh", "release", "view", RELEASE_TAG, "--repo", REPO],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        subprocess.run(
            # --latest=false: the mod-hub release must never claim
            # releases/latest — that slot belongs to the app's v* tags
            # (the in-app updater and the website download page follow it).
            ["gh", "release", "create", RELEASE_TAG, "--repo", REPO, "--title", RELEASE_TITLE,
             "--latest=false",
             "--notes", "Mod Hub package store. Assets are re-hosted copies of third-party mods "
                        "ingested from Aslain's WoWs Modpack; see the linked Discussions threads "
                        "for hashes, sources and attribution."],
            check=True,
        )
    uploads: list[Path] = []
    for mod in state["mods"]:
        out_dir = cache / "assets" / mod["id"]
        for idx, pkg in enumerate(mod["packages"], start=1):
            suffix = "" if len(mod["packages"]) == 1 else f"-part{idx}"
            asset_name = f"{mod['id']}-{mod['version']}{suffix}.zip"
            dest = out_dir / asset_name
            dest.parent.mkdir(parents=True, exist_ok=True)
            # Always restage from `packages/`: a staged copy left by an
            # earlier run may predate a 7z->zip repack and would
            # otherwise re-upload the old container against the new hash.
            dest.write_bytes((cache / "packages" / mod["id"] / pkg["name"]).read_bytes())
            pkg["asset"] = asset_name
            pkg["download_url"] = f"https://github.com/{REPO}/releases/download/{RELEASE_TAG}/{asset_name}"
            uploads.append(dest)
    for i in range(0, len(uploads), 20):
        batch = uploads[i : i + 20]
        subprocess.run(["gh", "release", "upload", RELEASE_TAG, "--repo", REPO, "--clobber", *[str(p) for p in batch]], check=True)
        print(f"  uploaded {i + len(batch)}/{len(uploads)}", flush=True)
    (cache / "downloaded.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(uploads)} assets ensured on release {RELEASE_TAG}")


# ---------------------------------------------------------------- discussions


CRAWL_QUERY = """
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    id
    discussions(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id number title body }
    }
  }
}
"""

SIGNAL_NOTE = (
    "> Republished from Aslain's WoWs Modpack by WoWSP; all content belongs to the "
    "original authors linked above.\n"
    "> Compatibility reports: comment `game <version> ok` or `game <version> broken` "
    "and the indexer will pick them up."
)


def aliases_line(mod: dict) -> str:
    """The `aliases: a, b` front-matter line ('' when the entry declares
    none). Values may not contain commas or colons — front-matter values
    here are plain words by construction."""
    names = aliases_of(mod)
    return f"aliases: {', '.join(names)}" if names else ""


def preview_gallery(mod: dict) -> list[str]:
    """Markdown image lines for every uploaded screenshot (gallery first,
    the legacy single attachment respected)."""
    urls = list(mod.get("preview_attachments") or [])
    single = mod.get("preview_attachment") or ""
    if single and single not in urls:
        urls.insert(0, single)
    return [f"![{mod['name_en']}]({u})" for u in urls if u]


def discussion_body(mod: dict) -> str:
    front = [
        "---",
        f"wowsp-mod: {mod['id']}",
        f"version: {mod['version']}",
        f'game: "{mod["game"]}"',
        f"category: {mod['category']}",
    ]
    append_author_lines(front, mod["id"])
    alias = aliases_line(mod)
    if alias:
        front.append(alias)
    front += ["license: Unspecified (upstream)", "---", ""]
    lines = front
    if mod.get("i18n"):
        lines.append(build_i18n_block(mod["i18n"]))
        lines.append("")
        lines.append(build_i18n_details(mod["i18n"]))
        lines.append("")
    gallery = preview_gallery(mod)
    if gallery:
        lines.extend(gallery)
        lines.append("")
    title = f"**{mod['name_zh']}** / {mod['name_en']}" if mod["name_zh"] else f"**{mod['name_en']}**"
    lines.append(title)
    lines.append("")
    if mod["description"]:
        lines.append(mod["description"])
        lines.append("")
    lines.append("### 下载 / Download")
    lines.append("")
    for pkg in mod["packages"]:
        lines.append(
            f"- [`{pkg['asset']}`]({pkg['download_url']}) — {max(1, pkg['size_bytes'] // 1024)} KB · "
            f"SHA-256 `{pkg['sha256']}`"
        )
    lines.append("")
    lines.append("| | |")
    lines.append("| --- | --- |")
    lines.append(f"| 版本 / version | `{mod['version']}` |")
    lines.append(f"| 兼容 / game | `{mod['game']}` |")
    if mod.get("first_party"):
        source = "WoWSP official patch (first-party, CC0-1.0)"
    else:
        source = "[Aslain's WoWs Modpack](https://aslain.com/) · catalog v.15.7.0"
        if mod["author_url"]:
            source += f" · [author]({mod['author_url']})"
    lines.append(f"| 来源 / source | {source} |")
    lines.append("")
    lines.append(SIGNAL_NOTE)
    return "\n".join(lines)


CREATE_MUTATION = """
mutation($input: CreateDiscussionInput!) {
  createDiscussion(input: $input) { discussion { number url } }
}
"""


def discussions(cache: Path) -> None:
    state = downloaded_state(cache)
    data = gh_graphql(CRAWL_QUERY, owner=REPO.split("/")[0], name=REPO.split("/")[1])
    repo_node = data["repository"]
    existing: dict[str, int] = {}
    nodes = repo_node["discussions"]["nodes"]
    page = repo_node["discussions"]["pageInfo"]
    while page["hasNextPage"]:
        data = gh_graphql(CRAWL_QUERY, owner=REPO.split("/")[0], name=REPO.split("/")[1], cursor=page["endCursor"])
        nodes.extend(data["repository"]["discussions"]["nodes"])
        page = data["repository"]["discussions"]["pageInfo"]
    fm = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)
    for node in nodes:
        m = fm.match(node["body"] or "")
        if m and (kv := re.search(r"wowsp-mod:\s*(\S+)", m.group(1))):
            existing.setdefault(kv.group(1), node["number"])
    print(f"{len(existing)} mod threads already present, {len(state['mods'])} in selection")
    created = 0
    for mod in state["mods"]:
        if mod["id"] in existing:
            print(f"  = {mod['id']} -> #{existing[mod['id']]}")
            continue
        title = thread_title(mod)
        result = gh_graphql(
            CREATE_MUTATION,
            input={
                "repositoryId": repo_node["id"],
                "categoryId": "DIC_kwDOTZ4Crs4DERxL",  # Show and tell, same as #91
                "title": title,
                "body": discussion_body(mod),
            },
        )
        discussion = result["createDiscussion"]["discussion"]
        mod["discussion_number"] = discussion["number"]
        created += 1
        print(f"  + {mod['id']} -> #{discussion['number']}", flush=True)
        time.sleep(0.5)
    (cache / "downloaded.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{created} discussions created")


# ---------------------------------------------------------------- index


UPDATE_MUTATION = """
mutation($input: UpdateDiscussionInput!) {
  updateDiscussion(input: $input) { discussion { number } }
}
"""


def crawl_thread_ids() -> dict[str, dict]:
    """slug -> {number, id} for every discussion carrying front-matter."""
    fm = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)
    kv = re.compile(r"wowsp-mod:\s*(\S+)")
    data = gh_graphql(CRAWL_QUERY, owner=REPO.split("/")[0], name=REPO.split("/")[1])
    repo_node = data["repository"]
    nodes = repo_node["discussions"]["nodes"]
    page = repo_node["discussions"]["pageInfo"]
    while page["hasNextPage"]:
        data = gh_graphql(CRAWL_QUERY, owner=REPO.split("/")[0], name=REPO.split("/")[1], cursor=page["endCursor"])
        nodes.extend(data["repository"]["discussions"]["nodes"])
        page = data["repository"]["discussions"]["pageInfo"]
    out: dict[str, dict] = {}
    for node in nodes:
        m = fm.match(node["body"] or "")
        if not m:
            continue
        slug = kv.search(m.group(1))
        if slug:
            out[slug.group(1)] = {"number": node["number"], "id": node["id"]}
    return out


def update_bodies(cache: Path) -> None:
    """Rewrite every published thread from the current state (i18n refits,
    template tweaks). Threads are located by front-matter slug."""
    state = downloaded_state(cache)
    ids = crawl_thread_ids()
    by_number = {t["number"]: t for t in ids.values()}
    updated = 0
    for mod in state["mods"]:
        # Locate by recorded number (the slug may have just been renamed);
        # fall back to the slug for threads never seen before.
        thread = by_number.get(mod.get("discussion_number")) or ids.get(mod["id"])
        if not thread:
            print(f"  ! no thread for {mod['id']}", flush=True)
            continue
        mod["discussion_number"] = thread["number"]
        mod["discussion_id"] = thread["id"]
        result = gh_graphql(
            UPDATE_MUTATION,
            input={
                "discussionId": thread["id"],
                "title": thread_title(mod),
                "body": discussion_body(mod),
            },
        )
        check = result["updateDiscussion"]["discussion"]["number"]
        assert check == thread["number"], f"{mod['id']}: updated #{check} instead of #{thread['number']}"
        updated += 1
        if updated % 20 == 0:
            print(f"  updated {updated}", flush=True)
        time.sleep(0.4)
    (cache / "downloaded.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{updated} discussion bodies updated")


# ---------------------------------------------------------------- enrich


# Download/preset lines are the only irreplaceable payload in a thread
# body (URLs + SHA-256 of the release assets) — `enrich` copies them
# verbatim instead of regenerating from state it may not have.
DOWNLOAD_LINE_RE = re.compile(r"^- \[`[^`]+`\]\(https?://[^)]+\).*$", re.MULTILINE)
PRESETS_BLOCK_SRC_RE = re.compile(r"<!--\nwowsp:presets\n.*?\nwowsp:presets\n-->", re.DOTALL)


def crawl_threads() -> list[dict]:
    """Every discussion node carrying wowsp-mod front-matter, with body."""
    data = gh_graphql(CRAWL_QUERY, owner=REPO.split("/")[0], name=REPO.split("/")[1])
    repo_node = data["repository"]
    nodes = repo_node["discussions"]["nodes"]
    page = repo_node["discussions"]["pageInfo"]
    while page["hasNextPage"]:
        data = gh_graphql(CRAWL_QUERY, owner=REPO.split("/")[0], name=REPO.split("/")[1], cursor=page["endCursor"])
        nodes.extend(data["repository"]["discussions"]["nodes"])
        page = data["repository"]["discussions"]["pageInfo"]
    fm = re.compile(r"\A---\s*\n(.*?)\n---", re.DOTALL)
    out = []
    for node in nodes:
        m = fm.match(node["body"] or "")
        if not m:
            continue
        kv = re.search(r"wowsp-mod:\s*(\S+)", m.group(1))
        if kv:
            out.append({"slug": kv.group(1), "number": node["number"], "id": node["id"],
                        "title": node["title"], "body": node["body"] or ""})
    return out


def parse_front_matter_map(body: str) -> dict[str, str]:
    m = re.match(r"\A---\s*\n(.*?)\n---", body or "", re.DOTALL)
    out: dict[str, str] = {}
    if not m:
        return out
    for line in m.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep:
            out[key.strip()] = value.strip().strip('"')
    return out


def merged_i18n(slug: str, curated: dict | None, body: str) -> dict:
    """Layered i18n for one thread: the live block first, Aslain's own
    localized names/descriptions fill the gaps, and the repository's
    curated translations (mod_hub_desc_i18n.json) win last — every locale
    ends up with a real description instead of a name-only stub."""
    i18n = {lang: dict(v) for lang, v in parse_i18n_block(body).items()}
    for lang, meta in ((curated or {}).get("loc_meta") or {}).items():
        entry = i18n.setdefault(lang, {"name": "", "desc": ""})
        if meta.get("name") and not entry.get("name"):
            entry["name"] = meta["name"]
        if meta.get("desc") and not entry.get("desc"):
            entry["desc"] = meta["desc"]
    for lang, desc in (DESC_I18N.get(slug) or {}).items():
        i18n.setdefault(lang, {"name": "", "desc": ""})["desc"] = desc
    # Name fixes OVERRIDE — attribution must stay out of display names even
    # when the live block or Aslain's own metadata carries it ("Team Panels",
    # never "Team Panels by AutoSpy"; the author lives in the tag).
    for lang, name in (DESC_I18N_NAMES.get(slug) or {}).items():
        if name:
            i18n.setdefault(lang, {"name": "", "desc": ""})["name"] = name
    return {lang: v for lang, v in i18n.items() if v.get("name") or v.get("desc")}


def enrich_body(curated: dict | None, thread: dict, gallery_urls: list[str]) -> str:
    """The next-generation thread body: refreshed front-matter (aliases,
    category override), the merged i18n block, a screenshot gallery and
    Aslain's full description — with the download/preset payload carried
    over byte-for-byte from the live body."""
    fm = parse_front_matter_map(thread["body"])
    slug = thread["slug"]
    category = CATEGORY_OVERRIDE.get(slug) or (curated or {}).get("category") or fm.get("category") or "aux"
    version = fm.get("version") or (curated or {}).get("version") or "1"
    game = fm.get("game") or (curated or {}).get("game") or "*"
    pseudo = {
        "id": slug,
        "version": version,
        "game": game,
        "category": category,
        "aslain_id": (curated or {}).get("aslain_id", ""),
    }
    i18n = merged_i18n(slug, curated, thread["body"])
    # The visible title line reads from the curated catalog names; the
    # registry's name fixes win there too so attribution stays out.
    name_en = (DESC_I18N_NAMES.get(slug) or {}).get("en-US") or (curated or {}).get("name_en") or slug
    name_zh = (DESC_I18N_NAMES.get(slug) or {}).get("zh-CN") or (curated or {}).get("name_zh") or ""
    lines = ["---", f"wowsp-mod: {slug}", f"version: {version}", f'game: "{game}"', f"category: {category}"]
    append_author_lines(lines, slug)
    alias = aliases_line(pseudo)
    if alias:
        lines.append(alias)
    lines += ["license: Unspecified (upstream)", "---", ""]
    if i18n:
        lines.append(build_i18n_block(i18n))
        lines.append("")
        lines.append(build_i18n_details(i18n))
        lines.append("")
    for url in gallery_urls:
        lines.append(f"![{name_en}]({url})")
    if gallery_urls:
        lines.append("")
    title = f"**{name_zh}** / {name_en}" if name_zh else f"**{name_en}**"
    lines.append(title)
    lines.append("")
    desc = (DESC_I18N.get(slug) or {}).get("en-US") or (curated or {}).get("description") or ""
    if desc:
        lines.append(desc)
        lines.append("")
    presets_block = PRESETS_BLOCK_SRC_RE.search(thread["body"])
    if presets_block:
        lines.append(presets_block.group(0))
        lines.append("")
    downloads = DOWNLOAD_LINE_RE.findall(thread["body"])
    if downloads:
        lines.append("### 下载 / Download")
        lines.append("")
        lines.extend(downloads)
        lines.append("")
    lines.append("| | |")
    lines.append("| --- | --- |")
    lines.append(f"| 版本 / version | `{version}` |")
    lines.append(f"| 兼容 / game | `{game}` |")
    author_url = (curated or {}).get("author_url", "")
    source = "[Aslain's WoWs Modpack](https://aslain.com/)"
    if author_url:
        source += f" · [author]({author_url})"
    lines.append(f"| 来源 / source | {source} |")
    lines.append("")
    lines.append(SIGNAL_NOTE)
    return "\n".join(lines)


def upload_galleries(cache: Path, state_path: Path) -> dict[str, list[str]]:
    """Upload every mod's preview screenshots once; results cached by
    slug so re-runs never re-upload."""
    state = load_state(cache)
    cached: dict[str, list[str]] = {}
    if state_path.exists():
        cached = json.loads(state_path.read_text(encoding="utf-8"))
    repo_id = None
    for mod in state["mods"]:
        urls = mod.get("preview_urls") or ([mod["preview_url"]] if mod.get("preview_url") else [])
        if not urls:
            continue
        key = mod["id"]
        if key in cached and len(cached[key]) == len(urls):
            continue
        if repo_id is None:
            repo_id = json.loads(gh(f"repos/{REPO}"))["id"]
        uploaded: list[str] = []
        for idx, url in enumerate(urls, start=1):
            dest = cache / "previews" / f"{mod['id']}-{idx}.jpg"
            try:
                data = dest.read_bytes() if dest.exists() else fetch_binary(url, dest).read_bytes()
                uploaded.append(upload_user_attachment(data, f"{mod['id']}-{idx}.jpg", "image/jpeg", str(repo_id)))
                time.sleep(0.2)
            except Exception as exc:  # noqa: BLE001 - previews are best-effort
                print(f"  gallery {mod['id']} #{idx} FAILED: {exc}", flush=True)
        if uploaded:
            cached[key] = uploaded
            state_path.write_text(json.dumps(cached, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"  gallery {mod['id']}: {len(uploaded)} image(s)", flush=True)
    return cached


def enrich(cache: Path, only: str | None = None, dry_run: bool = False) -> None:
    """Rewrite every published thread to the enriched template WITHOUT the
    original publish state: download lines, presets and signals survive
    byte-for-byte from the live body, while front-matter (aliases,
    category), the i18n block, descriptions and the screenshot gallery are
    rebuilt from a fresh Aslain curate pass. `--only <slug>` restricts the
    run; `--dry-run` prints the would-be body instead of mutating."""
    if not (cache / "curated.json").exists():
        print("curated.json missing - running curate first", flush=True)
        curate(cache)
    state = load_state(cache)
    curated_by_id = {m["id"]: m for m in state["mods"]}
    galleries = {} if dry_run else upload_galleries(cache, cache / "galleries.json")
    threads = crawl_threads()
    updated = 0
    for thread in threads:
        slug = thread["slug"]
        if only and slug != only:
            continue
        curated = curated_by_id.get(slug)
        if (
            not curated
            and slug not in CATEGORY_OVERRIDE
            and slug not in ASLAIN_ALIASES
            and slug not in DESC_I18N
        ):
            continue  # threads neither ingested nor curated stay untouched
        body = thread["body"]
        existing_gallery = [m.group(1) for m in re.finditer(r"!\[[^\]]*\]\((https://[^)]+)\)", body)]
        gallery = galleries.get(slug) or existing_gallery
        new_body = enrich_body(curated, thread, gallery)
        if new_body.strip() == body.strip():
            print(f"  = {slug} -> #{thread['number']} (unchanged)", flush=True)
            continue
        if dry_run:
            print(f"--- would update {slug} #{thread['number']} ---")
            print(new_body[:1200])
            continue
        result = gh_graphql(
            UPDATE_MUTATION,
            input={"discussionId": thread["id"], "body": new_body},
        )
        check = result["updateDiscussion"]["discussion"]["number"]
        assert check == thread["number"], f"{slug}: updated #{check} instead of #{thread['number']}"
        updated += 1
        if updated % 20 == 0:
            print(f"  updated {updated}", flush=True)
        time.sleep(0.4)
    print(f"{updated} discussion bodies enriched" + (" (dry run)" if dry_run else ""))


def migrate_assets(cache: Path) -> None:
    """One-shot asset rename: delete every release asset whose name does not
    match the current `<slug>[-partN].zip` scheme, then upload the packages
    under their standardized names. mod-index.json is refreshed by `index`."""
    state = downloaded_state(cache)
    expected: dict[str, Path] = {}
    for mod in state["mods"]:
        origin = mod.get("prev_id", mod["id"])
        n_pkgs = len(mod["packages"])
        for i, pkg in enumerate(mod["packages"], start=1):
            suffix = "" if n_pkgs == 1 else f"-part{i}"
            local = Path(cache) / "packages" / origin / pkg["name"]
            assert local.is_file(), f"missing local package {local}"
            expected[f"{mod['id']}{suffix}.zip"] = local

    release = json.loads(gh(f"repos/{REPO}/releases/tags/{RELEASE_TAG}"))
    stale = [a for a in release["assets"] if a["name"] not in expected and a["name"] != "mod-index.json"]
    for a in stale:
        gh("-X", "DELETE", f"repos/{REPO}/releases/assets/{a['id']}")
    print(f"deleted {len(stale)} stale assets", flush=True)

    uploads = sorted(expected.items())
    for i in range(0, len(uploads), 20):
        batch = uploads[i : i + 20]
        args = ["release", "upload", RELEASE_TAG, "--repo", REPO, "--clobber"]
        for name, local in batch:
            staged = Path(cache) / "assets" / "_migrated" / name
            staged.parent.mkdir(parents=True, exist_ok=True)
            # Always restage: a copy left by an earlier run may predate a
            # 7z->zip repack of the same package.
            staged.write_bytes(local.read_bytes())
            args.append(str(staged))
        subprocess.run(["gh", *args], check=True)
        print(f"  uploaded {i + len(batch)}/{len(uploads)}", flush=True)
    print(f"{len(uploads)} standardized assets ensured")


def build_index(state: dict) -> dict:
    mods: dict[str, dict] = {}
    for mod in state["mods"]:
        entry = mods.setdefault(
            mod["id"],
            {
                "id": mod["id"],
                "category": mod["category"],
                "license": "Unspecified (upstream)",
                "versions": {},
                "signals": {},
                "discussion": mod.get("discussion_number"),
                **({"aliases": aliases_of(mod)} if aliases_of(mod) else {}),
            },
        )
        rec_authors = author_record(mod["id"])
        entry["versions"][mod["version"]] = {
            "game": mod["game"],
            "title": mod["name_en"],
            "name_en": mod["name_en"],
            "name_zh": mod["name_zh"],
            "description": mod["description"],
            "i18n": mod.get("i18n") or {},
            "preview": (mod.get("preview_attachments") or [mod.get("preview_attachment") or ""])[0],
            # The registry wins (names + verified pages); the catalog's own
            # AuthorUrl is the first author's page fallback. The legacy
            # singular fields ride along for older consumers.
            "authors": [
                {"name": name, "url": url} for name, url in author_record(mod["id"])
            ],
            "author": rec_authors[0][0] if rec_authors else "",
            "author_url": (rec_authors[0][1] if rec_authors and rec_authors[0][1] else mod["author_url"]),
            "packages": [
                {
                    "url": pkg["download_url"],
                    "sha256": pkg["sha256"],
                    "size": pkg["size_bytes"],
                    "name": pkg["asset"],
                }
                for pkg in mod["packages"]
            ],
        }
        if entry["discussion"] is None and mod.get("discussion_number"):
            entry["discussion"] = mod["discussion_number"]
    for entry in mods.values():
        latest = sorted(entry["versions"])[-1]
        entry["latest"] = latest
        entry["game"] = entry["versions"][latest]["game"]
    return {
        "schema": 1,
        "source": {"kind": "aslain-ingest", "content_version": state["content_version"], "game_version": state["game_version"]},
        "mods": mods,
    }


def release_asset_names() -> set[str]:
    """Names of the assets the live mod-hub release actually serves."""
    release = json.loads(gh(f"repos/{REPO}/releases/tags/{RELEASE_TAG}"))
    return {a["name"] for a in release["assets"]}


def drop_missing_assets(index_json: dict, assets: set[str]) -> int:
    """Drop every package the live release cannot serve, in place.

    The index is emitted from local state, but the release is what the
    app downloads from — a silently missed upload (the live catalog once
    referenced two assets that 404) must shrink the index here, not fail
    every install of that entry. Mods left without any servable package
    leave the catalog; `latest` is recomputed over the survivors.
    """
    dropped = 0
    for entry in list(index_json["mods"].values()):
        for version in entry["versions"].values():
            keep = [pkg for pkg in version["packages"] if pkg["name"] in assets]
            dropped += len(version["packages"]) - len(keep)
            for pkg in version["packages"]:
                if pkg["name"] not in assets:
                    print(f"warning: dropping {pkg['name']} (missing from release {RELEASE_TAG})",
                          file=sys.stderr, flush=True)
            version["packages"] = keep
        entry["versions"] = {v: body for v, body in entry["versions"].items() if body["packages"]}
        if not entry["versions"]:
            print(f"warning: dropping mod {entry['id']} (no servable packages)", file=sys.stderr, flush=True)
            del index_json["mods"][entry["id"]]
            continue
        latest = sorted(entry["versions"])[-1]
        entry["latest"] = latest
        entry["game"] = entry["versions"][latest]["game"]
    return dropped


def should_refuse_upload(total: int, dropped: int, mods_left: int) -> bool:
    """Whether an index upload must be refused instead of shrunk.

    Small drift (a missed upload, a dropped package) shrinks the index;
    a wholesale drop means the state and the release disagree about
    asset NAMING (e.g. a `migrate-assets` run without a follow-up
    realignment), and an emptied state means nothing survived the gates
    — uploading in either case would blank the Mod Hub for every user.
    """
    return mods_left == 0 or (total > 0 and dropped / total > 0.25)


def index(cache: Path) -> None:
    state = downloaded_state(cache)
    index_json = build_index(state)
    total = sum(len(v["packages"]) for m in index_json["mods"].values() for v in m["versions"].values())
    dropped = drop_missing_assets(index_json, release_asset_names())
    if should_refuse_upload(total, dropped, len(index_json["mods"])):
        sys.exit(
            f"refusing to upload: {dropped}/{total} packages missing from release {RELEASE_TAG} "
            f"({len(index_json['mods'])} mods left) — state and release disagree on asset names; "
            f"re-run `release` first"
        )
    out = cache / "mod-index.json"
    out.write_text(json.dumps(index_json, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    subprocess.run(["gh", "release", "upload", RELEASE_TAG, "--repo", REPO, "--clobber", str(out)], check=True)
    print(f"mod-index.json ({len(index_json['mods'])} mods, {dropped} unservable packages dropped)"
          f" -> release {RELEASE_TAG}")
    # Second official channel — the relay worker's digest store; skips
    # without Cloudflare credentials (scripts/publish_digests.py).
    publish_digests.push_if_configured(
        "mod-hub",
        RELEASE_TAG,
        {"mod-index.json": hashlib.sha256(out.read_bytes()).hexdigest()},
        latest=True,
    )


# ---------------------------------------------------------------- selftest


def selftest() -> None:
    """Offline checks for the archive gates (no network, no gh calls)."""
    # Magic classification: real zip containers pass, 7z and anything
    # else do not.
    assert looks_like_zip(b"PK\x03\x04rest-of-archive")
    assert looks_like_zip(b"PK\x05\x06")  # an empty zip archive
    assert not looks_like_zip(SEVENZ_MAGIC + b"....")
    assert not looks_like_zip(b"\x89PNG\r\n\x1a\n")
    assert not looks_like_zip(b"")

    # 7z -> zip repack round-trip (only meaningful with a converter).
    binary = sevenz_binary()
    if binary:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            src_dir = tmp_dir / "tree" / "res_mods"
            src_dir.mkdir(parents=True)
            (src_dir / "mod.bin").write_bytes(b"payload-bytes")
            archive = tmp_dir / "pkg.7z"
            subprocess.run([binary, "a", str(archive), str(tmp_dir / "tree")],
                           check=True, capture_output=True)
            repacked = rezip_sevenz(archive, binary)
            assert looks_like_zip(repacked)
            with zipfile.ZipFile(io.BytesIO(repacked)) as zf:
                names = zf.namelist()
                assert any(n.endswith("res_mods/mod.bin") for n in names), names
                member = next(n for n in names if n.endswith("mod.bin"))
                assert zf.read(member) == b"payload-bytes"
        # An empty 7z repacks into a valid (empty) zip, not a drop.
        with tempfile.TemporaryDirectory() as tmp:
            empty_dir = Path(tmp) / "nothing"
            empty_dir.mkdir()
            archive = Path(tmp) / "empty.7z"
            subprocess.run([binary, "a", str(archive), str(empty_dir)],
                           check=True, capture_output=True)
            assert looks_like_zip(rezip_sevenz(archive, binary))
    else:
        print("  (no 7z binary found — repack round-trip skipped)")

    # Missing-asset filtering: packages the release cannot serve drop,
    # emptied versions drop, emptied mods drop, `latest` recomputes.
    def pkg(name: str) -> dict:
        return {"url": f"https://github.com/{REPO}/releases/download/{RELEASE_TAG}/{name}",
                "sha256": "a" * 64, "size": 1, "name": name}

    def version(pkgs: list[dict]) -> dict:
        return {"game": ">=15.7 <15.8", "packages": pkgs}

    index_json = {
        "mods": {
            "keep": {"id": "keep", "versions": {"1": version([pkg("keep-1.zip")]),
                                                "2": version([pkg("keep-2.zip"), pkg("gone-2.zip")])},
                     "latest": "2", "game": ">=15.7 <15.8"},
            "half": {"id": "half", "versions": {"1": version([pkg("keep-1.zip"), pkg("gone-1.zip")])},
                     "latest": "1", "game": ">=15.7 <15.8"},
            "flip": {"id": "flip", "versions": {"1": version([pkg("keep-1.zip")]),
                                                "9": version([pkg("gone-9.zip")])},
                     "latest": "9", "game": ">=15.7 <15.8"},
            "gone": {"id": "gone", "versions": {"1": version([pkg("gone-3.zip")])},
                     "latest": "1", "game": ">=15.7 <15.8"},
        }
    }
    dropped = drop_missing_assets(index_json, {"keep-1.zip", "keep-2.zip"})
    assert dropped == 4, dropped
    assert set(index_json["mods"]) == {"keep", "half", "flip"}, list(index_json["mods"])
    assert [p["name"] for p in index_json["mods"]["keep"]["versions"]["2"]["packages"]] == ["keep-2.zip"]
    assert index_json["mods"]["keep"]["latest"] == "2"
    # `flip`'s newest version lost its only package: `latest` must fall
    # back to the newest SURVIVING version, not stay on an emptied one.
    assert set(index_json["mods"]["flip"]["versions"]) == {"1"}
    assert index_json["mods"]["flip"]["latest"] == "1"
    assert index_json["mods"]["half"]["versions"]["1"]["packages"] == [
        {"url": f"https://github.com/{REPO}/releases/download/{RELEASE_TAG}/keep-1.zip",
         "sha256": "a" * 64, "size": 1, "name": "keep-1.zip"}
    ]

    # The upload guard: small drift uploads, wholesale loss refuses —
    # and an emptied catalog refuses regardless of the ratio's shape.
    assert not should_refuse_upload(258, 2, 256), "live drift shape must upload"
    assert not should_refuse_upload(100, 25, 75), "exactly at the threshold uploads"
    assert should_refuse_upload(100, 26, 74), "past the threshold refuses"
    assert should_refuse_upload(10, 10, 0), "no mods left refuses"
    assert should_refuse_upload(0, 0, 0), "empty state refuses"
    print("selftest ok")


# ---------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "stage",
        choices=["curate", "download", "previews", "release", "discussions",
                 "update-bodies", "enrich", "migrate-assets", "index", "selftest"],
    )
    ap.add_argument("--only", help="enrich only: restrict to one slug")
    ap.add_argument("--cache-dir", default=str(Path(tempfile.gettempdir()) / "wowsp-modhub"))
    ap.add_argument("--dry-run", action="store_true", help="curate only: print the selection and exit")
    args = ap.parse_args(argv)
    cache = Path(args.cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    if args.stage == "curate":
        curate(cache, dry_run=args.dry_run)
    elif args.stage == "download":
        download(cache)
    elif args.stage == "previews":
        previews(cache)
    elif args.stage == "release":
        release(cache)
    elif args.stage == "discussions":
        discussions(cache)
    elif args.stage == "update-bodies":
        update_bodies(cache)
    elif args.stage == "enrich":
        enrich(cache, only=args.only, dry_run=args.dry_run)
    elif args.stage == "migrate-assets":
        migrate_assets(cache)
    elif args.stage == "index":
        index(cache)
    elif args.stage == "selftest":
        selftest()
    return 0


if __name__ == "__main__":
    sys.exit(main())
