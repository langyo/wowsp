#!/usr/bin/env python3
"""Generate the worker-served copy of the WoWSP site with a RESOURCE
CANDIDATE CHAIN: every built asset is tried from the GitHub Pages
mirror first (fast for most visitors) and falls back to THIS worker's
own /wowsp/** copy (same build, same hashes) when the mirror is
unreachable — Cloudflare then only ever carries the small HTML shell,
never the heavy downloads, unless GitHub is down.

Usage: python scripts/build_worker_site.py <dist/website-dir> <out-dir>
The build itself must use WOWSP_SITE_BASE=/wowsp/ so both origins
serve identical file paths. Out layout:
  <out>/wowsp/**      the full build (fallback candidate base)
  <out>/*(public)     root-level public files (worker-root mode)
  <out>/index.html    the built index.html with the loader injected
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ENTRY_RE = re.compile(r'<script type="module"[^>]*src="([^"]+)"')
STYLESHEET_RE = re.compile(r'<link rel="stylesheet"[^>]*href="([^"]+)"')

# Strip the tags that go through the loader (entry script, preloads,
# stylesheets); everything else (favicon, manifest — small files that
# resolve natively on BOTH origins thanks to the /wowsp/ prefix) stays.
SHELL_STRIPS = [
    re.compile(r'<script type="module"[^>]*src="/wowsp/[^"]*"></script>\n?'),
    re.compile(r'<link rel="modulepreload"[^>]*href="/wowsp/[^"]*">\n?'),
    re.compile(r'<link rel="stylesheet"[^>]*href="/wowsp/[^"]*">\n?'),
]

CANDIDATES = ["https://langyo.github.io/wowsp", ""]

# The loader body is literal JavaScript (braces everywhere, no bare `%`),
# so %-style substitution keeps it readable. `json.dumps` with tight
# separators matches what JS `JSON.stringify` emits for these arrays.
LOADER_TEMPLATE = """<script>
(function () {
  var bases = %s;
  var entry = %s;
  var styles = %s;
  function fail() {
    document.body.insertAdjacentHTML("beforeend",
      '<p style="color:#f66;font:14px sans-serif;padding:16px">应用资源加载失败——请检查网络后刷新重试。</p>');
  }
  function chain(make, i) {
    if (i >= bases.length) { fail(); return; }
    make(bases[i], function () { chain(make, i + 1); });
  }
  styles.forEach(function (href) {
    chain(function (base, next) {
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = base + href;
      l.onerror = next;
      document.head.appendChild(l);
    });
  });
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


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 2:
        print("usage: build_worker_site.py <distDir> <outDir>", file=sys.stderr)
        return 1
    src_dir = Path(args[0])
    out_dir = Path(args[1]).resolve()

    # newline="" reads the HTML exactly as on disk; the write side pins
    # LF so Windows never translates it behind our backs.
    html = (src_dir / "index.html").read_text(encoding="utf-8", newline="")

    # Collect the module entry + stylesheets (all /wowsp/... paths after
    # the base=/wowsp/ build).
    sources = ENTRY_RE.findall(html)
    styles = STYLESHEET_RE.findall(html)
    if not sources:
        print(f"no module entry found in {src_dir / 'index.html'}", file=sys.stderr)
        return 1

    shell = html
    for pattern in SHELL_STRIPS:
        shell = pattern.sub("", shell)

    tight = {"separators": (",", ":")}
    loader = LOADER_TEMPLATE % (
        json.dumps(CANDIDATES, **tight),
        json.dumps(sources, **tight),
        json.dumps(styles, **tight),
    )

    # Fresh output: the full build nested at /wowsp/** (fallback
    # candidate), the public files ALSO at the root (worker-root mode
    # references via siteBase = "/"), and the loader entry at the root.
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src_dir, out_dir / "wowsp", dirs_exist_ok=True)
    shutil.copytree(src_dir, out_dir, dirs_exist_ok=True)
    shutil.rmtree(out_dir / "assets", ignore_errors=True)
    (out_dir / "404.html").unlink(missing_ok=True)
    # The JS swapped only the FIRST </body> (regex without /g) — keep that.
    (out_dir / "index.html").write_text(
        shell.replace("</body>", loader + "\n</body>", 1),
        encoding="utf-8",
        newline="\n",
    )

    candidates = " | ".join(c for c in CANDIDATES if c)
    print(
        f"worker site written: {len(sources)} entry module(s), "
        f"{len(styles)} stylesheet(s), candidates={candidates} | (origin)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
