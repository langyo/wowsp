#!/usr/bin/env python3
"""Mod Hub discussions indexer (M10.3 groundwork).

Pulls resource posts from GitHub Discussions, parses the templated
front-matter (see docs/<lang>/designs/mod-hub.md §2) plus the compatibility
signals players leave in the comments (`game <version> ok|broken`), and
emits the aggregated `mod-index.json` shared by the website catalog and the
in-app browser.

No third-party deps: GraphQL goes through the `gh` CLI, front-matter is
parsed by hand. The Actions schedule (or `just mod-index`) wraps this later.

    python scripts/mod_index.py --repo langyo/wowsp --out mod-index.json
    python scripts/mod_index.py --selftest
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

QUERY = """
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body closed author { login }
        comments(first: 50) { nodes { body author { login } } }
      }
    }
  }
}
"""

FRONT_MATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
SIGNAL_RE = re.compile(r"\bgame\s+([0-9][\w.]*)\s+(ok|broken)\b", re.IGNORECASE)
# Publisher template body line (see scripts/mod_hub_publish.py):
#   - [`asset.zip`](url) — 57 KB · SHA-256 `abc…`
DOWNLOAD_RE = re.compile(
    r"-\s*\[`([^`]+)`\]\((https?://[^)]+)\)\s*[—-]\s*(\d+)\s*KB\s*[·.]\s*SHA-256\s*`([0-9a-fA-F]{64})`"
)
# A download line additionally tagged as one named preset (scheme) of the
# entry — same shape as DOWNLOAD_RE plus a trailing `· preset \`id\``:
#   - [`asset.zip`](url) — 57 KB · SHA-256 `abc…` · preset `colorblind`
# Preset lines are swept out of the body BEFORE the plain DOWNLOAD_RE pass so
# they never leak into the entry's default package list.
PRESET_LINE_RE = re.compile(
    # Same-line only ([ 	], never \s): a plain download line followed by a
    # line starting with " · preset …" must not merge into one preset.
    DOWNLOAD_RE.pattern + r"[ 	]*[·.][ 	]*preset[ 	]*`([a-z0-9][a-z0-9-]*)`"
)
# Hidden preset label block (same invisible-comment pattern as wowsp:i18n):
#   <!--
#   wowsp:presets
#   sasagcy: Sasagcy 配色 | Sasagcy palette
#   classic: 经典配色 | Classic palette
#   wowsp:presets
#   -->
# One line per preset: `id: <zh label> | <en label>`; declaration order is
# the catalog-facing order and the FIRST preset is the default scheme.
PRESETS_BLOCK_RE = re.compile(r"wowsp:presets\n(.*?)\nwowsp:presets", re.DOTALL)
PRESET_LABEL_RE = re.compile(r"^([a-z0-9][a-z0-9-]*):\s*(.+)$")
# Hidden localization block (invisible when rendered, present in raw body):
#   <!--
#   wowsp:i18n
#   en-US: Shot Timer | Counts down the 20s detection window…
#   zh-CN: 开火后倒计时20s | …
#   wowsp:i18n
#   -->
I18N_BLOCK_RE = re.compile(r"wowsp:i18n\n(.*?)\nwowsp:i18n", re.DOTALL)
I18N_LOCALE_RE = re.compile(r"^([a-z]{2,3}-[A-Za-z]{2,4}):\s*(.+)$")


def parse_i18n(body: str) -> dict:
    """Extract {locale: {name, desc}} from the wowsp:i18n comment block."""
    m = I18N_BLOCK_RE.search(body or "")
    if not m:
        return {}
    out: dict[str, dict] = {}
    for line in m.group(1).splitlines():
        loc = I18N_LOCALE_RE.match(line.strip())
        if not loc:
            continue
        name, _, desc = loc.group(2).partition("|")
        out[loc.group(1)] = {"name": name.strip(), "desc": desc.strip()}
    return out


def parse_presets(body: str) -> list[dict]:
    r"""Ordered preset list from a thread body: package lines tagged
    `· preset `id`` joined with the wowsp:presets label block. A preset
    without a label falls back to the id itself as its label; a label
    without packages is dropped (nothing to install)."""
    labels: dict[str, dict[str, str]] = {}
    order: list[str] = []
    m = PRESETS_BLOCK_RE.search(body or "")
    if m:
        for line in m.group(1).splitlines():
            lab = PRESET_LABEL_RE.match(line.strip())
            if not lab:
                continue
            zh, _, en = lab.group(2).partition("|")
            pid = lab.group(1)
            labels[pid] = {"name_zh": zh.strip(), "name_en": en.strip() or zh.strip()}
            order.append(pid)
    packages: dict[str, list[dict]] = {}
    for name, url, kb, digest, pid in PRESET_LINE_RE.findall(body or ""):
        packages.setdefault(pid, []).append(
            {"url": url, "sha256": digest.lower(), "size": int(kb) * 1024, "name": name}
        )
    out: list[dict] = []
    seen: set[str] = set()
    for pid in order + [p for p in packages if p not in labels]:
        if pid in seen:
            continue
        pkgs = packages.get(pid)
        if not pkgs:
            continue
        seen.add(pid)
        out.append(
            {
                "id": pid,
                "name_zh": labels.get(pid, {}).get("name_zh", pid),
                "name_en": labels.get(pid, {}).get("name_en", pid),
                "packages": pkgs,
            }
        )
    return out


def parse_front_matter(body: str) -> tuple[dict[str, str], str]:
    """Split a resource post into (front-matter dict, markdown body)."""
    m = FRONT_MATTER_RE.match(body or "")
    if not m:
        return {}, body or ""
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        key, _, value = line.partition(":")
        if not _:
            continue
        meta[key.strip()] = value.strip().strip('"').strip("'")
    return meta, body[m.end():]


def parse_signals(comments: list[dict]) -> dict[str, list[str]]:
    """Collect per-version ok/broken reporters from comment bodies."""
    signals: dict[str, list[str]] = {}
    for c in comments:
        for ver, verdict in SIGNAL_RE.findall(c.get("body") or ""):
            signals.setdefault(ver, []).append(c["author"]["login"])
    return signals


def version_sort_key(v: str) -> tuple:
    """Numeric-aware ordering for dotted version strings: `15.7.0.10` must
    sort AFTER `15.7.0.9` (plain string order gets that backwards). Each dot-
    separated segment compares as a number when it is one, else lexically
    after every numeric segment (pre-releases like `15.8.0-beta1`)."""
    key = []
    for seg in re.split(r"[.\-+]", v or ""):
        key.append((0, int(seg)) if seg.isdigit() else (1, seg))
    return tuple(key)


def index_discussions(nodes: list[dict]) -> dict:
    """Aggregate raw discussion nodes into the mod-index.json shape."""
    mods: dict[str, dict] = {}
    for d in nodes:
        meta, _ = parse_front_matter(d.get("body") or "")
        mod_id = meta.get("wowsp-mod")
        if not mod_id:
            continue
        signals = parse_signals(d.get("comments", {}).get("nodes", []))
        # Registry tag ids (comma-separated front-matter `tags:`) —
        # definitions live in the mod-tags registry, not the index.
        tag_ids = list(dict.fromkeys(
            t.strip()
            for t in (meta.get("tags") or "").split(",")
            if t.strip() and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", t.strip())
        ))
        entry = mods.setdefault(
            mod_id,
            {
                "id": mod_id,
                "category": meta.get("category", "aux"),
                "license": meta.get("license"),
                "versions": {},
                "signals": {},
                "discussion": d.get("number"),
                **({"tags": tag_ids} if tag_ids else {}),
            },
        )
        version = meta.get("version", "0")
        body = d.get("body") or ""
        presets = parse_presets(body)
        # Preset lines must not double-count as the entry's plain packages —
        # sweep them out before the generic download scan.
        packages = [
            {"url": url, "sha256": digest.lower(), "size": int(kb) * 1024, "name": name}
            for name, url, kb, digest in DOWNLOAD_RE.findall(PRESET_LINE_RE.sub("", body))
        ]
        if presets and not packages:
            # A fully preset-driven thread: the first declared scheme is the
            # default, so the entry's plain package list (what pre-preset
            # app builds install) mirrors it.
            packages = presets[0]["packages"]
        entry["versions"][version] = {
            "game": meta.get("game", "*"),
            "title": d.get("title"),
            "author": (d.get("author") or {}).get("login"),
        }
        if d.get("closed"):
            # Delisting signal: a closed thread means "this release is
            # withdrawn". Kept per-version so the entry verdict below can
            # tell "old release withdrawn, current one still live" apart.
            entry["versions"][version]["delisted"] = True
        if meta.get("bundled", "").lower() in ("true", "yes", "1"):
            # Ships inside the WoWSP app — listed without download packages.
            entry["versions"][version]["bundled"] = True
        if packages:
            entry["versions"][version]["packages"] = packages
        if presets:
            entry["versions"][version]["presets"] = presets
        i18n = parse_i18n(d.get("body") or "")
        if i18n:
            entry["versions"][version]["i18n"] = i18n
        for ver, reporters in signals.items():
            entry["signals"].setdefault(ver, []).extend(reporters)
    # Only the newest version is catalog-facing; keep compatibility verdicts.
    # A mod is delisted when the thread carrying its NEWEST version is
    # closed — closing an old release's thread while a newer one is live
    # does not delist the mod. Consumers hide delisted entries from the
    # list and surface an "unavailable" notice on deep links.
    for entry in mods.values():
        latest = max(entry["versions"], key=version_sort_key)
        entry["latest"] = latest
        entry["game"] = entry["versions"][latest]["game"]
        if entry["versions"][latest].get("delisted"):
            entry["delisted"] = True
    return {"schema": 1, "mods": mods}


def fetch(repo: str) -> list[dict]:
    owner, _, name = repo.partition("/")
    nodes: list[dict] = []
    cursor = None
    while True:
        args = ["gh", "api", "graphql", "-f", f"query={QUERY}", "-f", f"owner={owner}", "-f", f"name={name}"]
        if cursor:
            args += ["-f", f"cursor={cursor}"]
        out = subprocess.run(args, capture_output=True, text=True, check=True).stdout
        data = json.loads(out)["data"]["repository"]["discussions"]
        nodes.extend(data["nodes"])
        if not data["pageInfo"]["hasNextPage"]:
            return nodes
        cursor = data["pageInfo"]["endCursor"]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", default="langyo/wowsp")
    ap.add_argument("--out", default="mod-index.json")
    ap.add_argument("--selftest", action="store_true", help="run offline parser checks")
    args = ap.parse_args(argv)

    if args.selftest:
        meta, md = parse_front_matter(
            "---\nwowsp-mod: ime-config\nversion: \"23.3.26\"\ngame: \"*\"\ncategory: patches\n---\nbody…"
        )
        assert meta["wowsp-mod"] == "ime-config" and meta["version"] == "23.3.26", meta
        assert md.startswith("body"), md
        sig = parse_signals([
            {"body": "game 14.6.2 ok", "author": {"login": "a"}},
            {"body": "GAME 14.7 BROKEN", "author": {"login": "b"}},
            {"body": "unrelated", "author": {"login": "c"}},
        ])
        assert sig == {"14.6.2": ["a"], "14.7": ["b"]}, sig
        idx = index_discussions([
            {"number": 91, "title": "t", "author": {"login": "langyo"},
             "body": "---\nwowsp-mod: ime-config\nversion: 1\ncategory: patches\n---\nx",
             "comments": {"nodes": [{"body": "game 14.6 ok", "author": {"login": "u"}}]}},
        ])
        assert idx["mods"]["ime-config"]["latest"] == "1"
        assert idx["mods"]["ime-config"]["signals"] == {"14.6": ["u"]}
        i18n = parse_i18n(
            "<!--\nwowsp:i18n\nen-US: Shot Timer | Counts down 20s\n"
            "zh-CN: 开火后倒计时20s | 主炮开火后提示灭点窗口\nwowsp:i18n\n-->\nbody"
        )
        assert i18n["en-US"] == {"name": "Shot Timer", "desc": "Counts down 20s"}, i18n
        assert i18n["zh-CN"]["name"] == "开火后倒计时20s", i18n
        assert parse_i18n("no block here") == {}
        # Delisting: a closed thread on the newest release flags the entry;
        # the same verdict on an OLD release (newer one live) does not.
        def node(num, ver, closed):
            return {"number": num, "title": "t", "author": {"login": "a"}, "closed": closed,
                    "body": f"---\nwowsp-mod: m\nversion: {ver}\ncategory: battle\n---\nx",
                    "comments": {"nodes": []}}
        gone = index_discussions([node(1, "2", True), node(2, "1", False)])
        assert gone["mods"]["m"]["delisted"] is True
        live = index_discussions([node(1, "2", False), node(2, "1", True)])
        assert "delisted" not in live["mods"]["m"]
        open_mod = index_discussions([node(1, "1", False)])
        assert "delisted" not in open_mod["mods"]["m"]
        # Newest picks numerically: 15.7.0.10 > 15.7.0.9 (string order would
        # say otherwise), so a closed .10 with a live .9 is a real delist
        # while a closed .9 under a live .10 is not.
        v10_gone = index_discussions([node(1, "15.7.0.10", True), node(2, "15.7.0.9", False)])
        assert v10_gone["mods"]["m"]["latest"] == "15.7.0.10"
        assert v10_gone["mods"]["m"]["delisted"] is True
        v9_gone = index_discussions([node(1, "15.7.0.10", False), node(2, "15.7.0.9", True)])
        assert v9_gone["mods"]["m"]["latest"] == "15.7.0.10"
        assert "delisted" not in v9_gone["mods"]["m"]
        # Front-matter tags ride the entry as id list; malformed ids drop.
        tagged = index_discussions([
            {"number": 1, "title": "t", "author": {"login": "a"}, "closed": False,
             "body": "---\nwowsp-mod: m\nversion: 1\ncategory: voice\ntags: ai-generated, ip-blue-archive, BAD_TAG, ok-id\n---\nx",
             "comments": {"nodes": []}},
        ])
        assert tagged["mods"]["m"]["tags"] == ["ai-generated", "ip-blue-archive", "ok-id"]

        # Presets: tagged download lines ride entry.presets in label order,
        # never leak into the plain package list, and a fully preset-driven
        # thread backfills its plain list from the first (default) scheme.
        sha = "a" * 64
        sha2 = "b" * 64
        preset_body = (
            "---\nwowsp-mod: smi\nversion: 1\ncategory: battle\n---\n"
            "<!--\nwowsp:presets\n"
            "sasagcy: Sasagcy 配色 | Sasagcy palette\n"
            "classic: 经典配色 | Classic palette\n"
            "wowsp:presets\n-->\n"
            f"- [`smi-v4.zip`](https://x/v4.zip) — 1 KB · SHA-256 `{sha}` · preset `sasagcy`\n"
            f"- [`smi-v1.zip`](https://x/v1.zip) — 1 KB · SHA-256 `{sha2}` · preset `classic`\n"
        )
        idx = index_discussions([
            {"number": 1, "title": "t", "author": {"login": "a"}, "closed": False,
             "body": preset_body, "comments": {"nodes": []}},
        ])
        v = idx["mods"]["smi"]["versions"]["1"]
        assert [p["id"] for p in v["presets"]] == ["sasagcy", "classic"], v.get("presets")
        assert v["presets"][0]["name_zh"] == "Sasagcy 配色"
        assert v["presets"][0]["name_en"] == "Sasagcy palette"
        assert v["presets"][1]["packages"][0]["sha256"] == sha2
        assert [p["name"] for p in v["packages"]] == ["smi-v4.zip"], "first preset backfills the default"
        # Mixed body: plain lines stay plain, preset lines don't leak in, and
        # an unlabeled preset falls back to its id as the label.
        mixed_body = (
            "---\nwowsp-mod: mx\nversion: 1\ncategory: battle\n---\n"
            f"- [`mx.zip`](https://x/mx.zip) — 1 KB · SHA-256 `{sha}`\n"
            f"- [`mx-pct.zip`](https://x/pct.zip) — 1 KB · SHA-256 `{sha2}` · preset `percent`\n"
        )
        idx2 = index_discussions([
            {"number": 2, "title": "t", "author": {"login": "a"}, "closed": False,
             "body": mixed_body, "comments": {"nodes": []}},
        ])
        v2 = idx2["mods"]["mx"]["versions"]["1"]
        assert [p["name"] for p in v2["packages"]] == ["mx.zip"]
        assert [p["id"] for p in v2["presets"]] == ["percent"]
        assert v2["presets"][0]["name_zh"] == "percent"
        print("selftest ok")
        return 0

    index = index_discussions(fetch(args.repo))
    Path(args.out).write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(index['mods'])} mods -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
