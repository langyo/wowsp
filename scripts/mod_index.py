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
        number title body author { login }
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


def index_discussions(nodes: list[dict]) -> dict:
    """Aggregate raw discussion nodes into the mod-index.json shape."""
    mods: dict[str, dict] = {}
    for d in nodes:
        meta, _ = parse_front_matter(d.get("body") or "")
        mod_id = meta.get("wowsp-mod")
        if not mod_id:
            continue
        signals = parse_signals(d.get("comments", {}).get("nodes", []))
        entry = mods.setdefault(
            mod_id,
            {
                "id": mod_id,
                "category": meta.get("category", "aux"),
                "license": meta.get("license"),
                "versions": {},
                "signals": {},
                "discussion": d.get("number"),
            },
        )
        version = meta.get("version", "0")
        packages = [
            {"url": url, "sha256": digest.lower(), "size": int(kb) * 1024, "name": name}
            for name, url, kb, digest in DOWNLOAD_RE.findall(d.get("body") or "")
        ]
        entry["versions"][version] = {
            "game": meta.get("game", "*"),
            "title": d.get("title"),
            "author": (d.get("author") or {}).get("login"),
        }
        if packages:
            entry["versions"][version]["packages"] = packages
        i18n = parse_i18n(d.get("body") or "")
        if i18n:
            entry["versions"][version]["i18n"] = i18n
        for ver, reporters in signals.items():
            entry["signals"].setdefault(ver, []).extend(reporters)
    # Only the newest version is catalog-facing; keep compatibility verdicts.
    for entry in mods.values():
        latest = sorted(entry["versions"])[-1]
        entry["latest"] = latest
        entry["game"] = entry["versions"][latest]["game"]
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
        print("selftest ok")
        return 0

    index = index_discussions(fetch(args.repo))
    Path(args.out).write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(index['mods'])} mods -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
