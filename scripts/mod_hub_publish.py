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
    python scripts/mod_hub_publish.py index       # emit + upload mod-index.json

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
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

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
I18N_LOCALES = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "de-DE", "fr-FR"]


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


def parse_i18n_block(body: str) -> dict:
    """Read the wowsp:i18n block back out of a raw discussion body."""
    m = re.search(r"wowsp:i18n\n(.*?)\nwowsp:i18n", body or "", re.DOTALL)
    if not m:
        return {}
    out: dict = {}
    for line in m.group(1).splitlines():
        lang, sep, rest = line.partition(":")
        lang = lang.strip()
        if not sep or "/" not in lang:
            continue
        name, _, desc = rest.partition("|")
        out[lang] = {"name": name.strip(), "desc": desc.strip()}
    return out


# Slug migration table: legacy ingest ids -> taxonomical slugs
# (category.genus.species). Maintained in scripts/mod_hub_slugs.py; curate
# consults it so future Aslain refreshes land on the same names.
from mod_hub_slugs import CATEGORY_RENAME, SLUG_MAP  # noqa: E402 - repo-local

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


def gh(*args: str, input_text: str | None = None) -> str:
    cmd = ["gh", "api", *args]
    if input_text is not None:
        cmd += ["--input", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"gh api failed: {out.stderr.strip()[:500]}")
    return out.stdout


def gh_graphql(query: str, **fields) -> dict:
    # Object-typed variables (CreateDiscussionInput) only survive as real
    # objects when the whole request goes through as JSON on stdin.
    payload = json.dumps({"query": query, "variables": fields})
    out = subprocess.run(
        ["gh", "api", "graphql", "--input", "-"],
        input=payload, capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        raise RuntimeError(f"gh api graphql failed: {out.stderr.strip()[:500]}")
    return json.loads(out.stdout)["data"]


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
            preview = mod.attrib.get("Preview", "")
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
                    "preview_url": resolve_url(base_url, preview) if preview else "",
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


def download(cache: Path) -> None:
    state = load_state(cache)
    pkgs_dir = cache / "packages"
    done = 0
    for mod in state["mods"]:
        for pkg in mod["packages"]:
            dest = pkgs_dir / mod["id"] / pkg["name"]
            if dest.exists() and dest.stat().st_size > 0:
                data = dest.read_bytes()
            else:
                print(f"GET {pkg['url']}", flush=True)
                data = fetch_binary(pkg["url"], dest).read_bytes()
            pkg["sha256"] = hashlib.sha256(data).hexdigest()
            pkg["size_bytes"] = len(data)
            if pkg["size_kb"] and abs(len(data) // 1024 - pkg["size_kb"]) > max(2, pkg["size_kb"] // 2):
                print(f"  WARN size drift for {pkg['name']}: catalog {pkg['size_kb']} KB, got {len(data) // 1024} KB")
            done += 1
    (cache / "downloaded.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{done} packages downloaded & hashed -> {pkgs_dir}")


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
        _TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
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
    out = subprocess.run(["gh", "release", "view", RELEASE_TAG, "--repo", REPO], capture_output=True, text=True)
    if out.returncode != 0:
        subprocess.run(
            ["gh", "release", "create", RELEASE_TAG, "--repo", REPO, "--title", RELEASE_TITLE,
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
            if not dest.exists():
                dest.parent.mkdir(parents=True, exist_ok=True)
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


def discussion_body(mod: dict) -> str:
    lines = [
        "---",
        f"wowsp-mod: {mod['id']}",
        f"version: {mod['version']}",
        f'game: "{mod["game"]}"',
        f"category: {mod['category']}",
        "license: Unspecified (upstream)",
        "---",
        "",
    ]
    if mod.get("i18n"):
        lines.append(build_i18n_block(mod["i18n"]))
        lines.append("")
    if mod.get("preview_attachment"):
        lines.append(f"![{mod['name_en']}]({mod['preview_attachment']})")
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
        title = f"[Mod] {mod['name_zh'] or mod['name_en']} {mod['id']} {mod['version']}"
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
                "title": f"[Mod] {mod['name_zh'] or mod['name_en']} {mod['id']} {mod['version']}",
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
            if not staged.exists():
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
            },
        )
        entry["versions"][mod["version"]] = {
            "game": mod["game"],
            "title": f"{mod['name_zh']} / {mod['name_en']}".strip(" /"),
            "name_en": mod["name_en"],
            "name_zh": mod["name_zh"],
            "description": mod["description"],
            "i18n": mod.get("i18n") or {},
            "preview": mod.get("preview_attachment") or "",
            "author_url": mod["author_url"],
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


def index(cache: Path) -> None:
    state = downloaded_state(cache)
    index_json = build_index(state)
    out = cache / "mod-index.json"
    out.write_text(json.dumps(index_json, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    subprocess.run(["gh", "release", "upload", RELEASE_TAG, "--repo", REPO, "--clobber", str(out)], check=True)
    print(f"mod-index.json ({len(index_json['mods'])} mods) -> release {RELEASE_TAG}")


# ---------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["curate", "download", "previews", "release", "discussions", "update-bodies", "migrate-assets", "index"])
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
    elif args.stage == "migrate-assets":
        migrate_assets(cache)
    elif args.stage == "index":
        index(cache)
    return 0


if __name__ == "__main__":
    sys.exit(main())
