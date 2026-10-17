#!/usr/bin/env python3
"""Generate the worker-served copy of the WoWSP site with a RESOURCE
CANDIDATE CHAIN: the built entry JS is tried from the GitHub Pages
mirror first (fast for most visitors) and falls back to THIS worker's
own /wowsp/** copy (same build, same hashes) when the mirror is
unreachable — the worker always CARRIES the full copy but normally
SERVES only the small HTML shells, the public files and the docs; the
heavy app bundle leaves Cloudflare only when GitHub is down.

The site is PRERENDERED (packages/website/scripts/prerender.mjs): every
page shell ships its full markup, and its stylesheets (entry + route
CSS) are INLINED into the shell itself — first paint needs zero
external CSS, which is the whole point on slow links. Only the entry
module still goes through the candidate chain.

Usage: python scripts/build_worker_site.py <site-dir> <out-dir>
The build itself must use WOWSP_SITE_BASE=/wowsp/ so both origins
serve identical file paths. CI (the Deploy Site workflow) passes the
MERGED artifact (docs + website, `_site`); `just bundle-site` passes
`dist/website` (website-only local bundle). Out layout:
  <out>/wowsp/**            the full build (fallback candidate base)
  <out>/*(public)           root-level public files (worker-root mode)
  <out>/<page>/index.html   loader-injected shells for every prerendered
  <out>/index.html          page (depth-1 index.html with an entry tag)
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ENTRY_RE = re.compile(r'<script type="module"[^>]*src="([^"]+)"')
STYLESHEET_RE = re.compile(r'<link rel="stylesheet"[^>]*href="([^"]+)"')

# Strip the tags that move into the shell (entry script → loader,
# stylesheets → inline <style>); everything else (favicon, manifest —
# small files that resolve natively on BOTH origins thanks to the
# /wowsp/ prefix) stays.
SHELL_STRIPS = [
    re.compile(r'<script type="module"[^>]*src="/wowsp/[^"]*"></script>\n?'),
    re.compile(r'<link rel="modulepreload"[^>]*href="/wowsp/[^"]*">\n?'),
    re.compile(r'<link rel="stylesheet"[^>]*href="/wowsp/[^"]*">\n?'),
]

# The ORIGIN only — entry paths already carry their /wowsp/ prefix from
# the base=/wowsp/ build, so candidate + path lands on
# langyo.github.io/wowsp/** (mirror) or the same origin (worker copy).
CANDIDATES = ["https://langyo.github.io", ""]

# The loader body is literal JavaScript (braces everywhere, no bare `%`),
# so %-style substitution keeps it readable. `json.dumps` with tight
# separators matches what JS `JSON.stringify` emits for these arrays.
LOADER_TEMPLATE = """<script>
(function () {
  var bases = %s;
  var entry = %s;
  function fail() {
    document.body.insertAdjacentHTML("beforeend",
      '<p style="color:#f66;font:14px sans-serif;padding:16px">应用资源加载失败——请检查网络后刷新重试。</p>');
  }
  function loadEntry(i) {
    if (i >= bases.length) { fail(); return; }
    var s = document.createElement("script");
    s.type = "module";
    s.src = bases[i] + entry[0];
    s.onerror = function () { loadEntry(i + 1); };
    document.body.appendChild(s);
  }
  loadEntry(0);
})();
</script>"""


def read_page(path: Path) -> str:
    # newline="" reads the HTML exactly as on disk; the write side pins
    # LF so Windows never translates it behind our backs. Plain open()
    # (not Path.read_text/write_text): the newline= keyword only exists
    # on those since Python 3.13 and CI's runners ship 3.12.
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def write_page(path: Path, html: str) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)


def shell_pages(src_dir: Path) -> list[Path]:
    """Depth-1 index.html pages that carry the app's entry module — the
    prerendered website pages. Docs and other static index.html files
    (lagrange output) have no module entry and stay untouched."""
    pages: list[Path] = []
    candidates = [Path("index.html")]
    for entry in sorted(src_dir.iterdir()):
        if entry.is_dir() and (entry / "index.html").is_file():
            # iterdir yields src_dir-prefixed paths; keep the candidate
            # RELATIVE so src_dir / rel composes correctly.
            candidates.append(Path(entry.name) / "index.html")
    for rel in candidates:
        if ENTRY_RE.search(read_page(src_dir / rel)):
            pages.append(rel)
    return pages


def make_shell(src_dir: Path, rel: Path) -> tuple[str, list[str]]:
    """Strip the chain-loaded tags from one page, inline its stylesheets
    into <head> and return the shell plus its entry-module sources."""
    html = read_page(src_dir / rel)
    sources = ENTRY_RE.findall(html)
    styles = STYLESHEET_RE.findall(html)
    if not sources:
        raise RuntimeError(f"no module entry found in {src_dir / rel}")

    shell = html
    for pattern in SHELL_STRIPS:
        shell = pattern.sub("", shell)

    # Inline the page's stylesheets (hrefs are /wowsp/-prefixed from the
    # base=/wowsp/ build). A literal "</style" cannot appear in minified
    # CSS outside strings/comments, and the escaped form is valid in both.
    css_parts = []
    for href in styles:
        css_path = src_dir / href.removeprefix("/wowsp/")
        css_parts.append(read_page(css_path))
    inline = "<style>" + "".join(css_parts).replace("</style", "<\\/style") + "</style>"
    shell = shell.replace("</head>", inline + "\n  </head>", 1)
    return shell, sources


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 2:
        print("usage: build_worker_site.py <distDir> <outDir>", file=sys.stderr)
        return 1
    src_dir = Path(args[0])
    out_dir = Path(args[1]).resolve()

    pages = shell_pages(src_dir)
    if not pages:
        print(f"no shell pages found in {src_dir}", file=sys.stderr)
        return 1

    tight = {"separators": (",", ":")}
    shells: dict[Path, str] = {}
    entry_count = 0
    for rel in pages:
        shell, sources = make_shell(src_dir, rel)
        # The JS swaps only the FIRST </body> (regex without /g) — keep that.
        loader = LOADER_TEMPLATE % (
            json.dumps(CANDIDATES, **tight),
            json.dumps(sources, **tight),
        )
        shells[rel] = shell.replace("</body>", loader + "\n</body>", 1)
        entry_count += len(sources)

    # Fresh output: the full build nested at /wowsp/** (fallback
    # candidate), the public files ALSO at the root (worker-root mode
    # references via siteBase = "/"), and the loader-injected shells at
    # the root.
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src_dir, out_dir / "wowsp", dirs_exist_ok=True)
    shutil.copytree(src_dir, out_dir, dirs_exist_ok=True)
    shutil.rmtree(out_dir / "assets", ignore_errors=True)
    (out_dir / "404.html").unlink(missing_ok=True)
    # _headers is honored ONLY at the assets root (tracked source:
    # packages/website/src/res/_headers — the website build's publicDir
    # carries it into the site dir); the nested wowsp/ copy would ship
    # as a stray static file — drop it.
    (out_dir / "wowsp" / "_headers").unlink(missing_ok=True)
    for rel, shell in shells.items():
        write_page(out_dir / rel, shell)

    candidates = " | ".join(c for c in CANDIDATES if c)
    print(
        f"worker site written: {len(shells)} prerendered shell(s) "
        f"({', '.join(p.as_posix() for p in shells)}), {entry_count} entry "
        f"module(s), candidates={candidates} | (origin)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
