#!/usr/bin/env python3
"""Fail on markdown lines that hang the site builder (lagrange).

A markdown line starting with '#<digits>' (e.g. a soft-wrapped issue
reference like '#604).') sends lagrange's build into a runaway loop that
never finishes — on CI the runner is killed mid-build ("The runner has
received a shutdown signal"). This took the Deploy Site workflow down for
three days (2026-10-09..12, every run since PR #931) before being traced
to docs/ru/designs/ingame-stats-plugin.md.

Guarded pattern: '^#\\d' at the start of any docs/**/*.md line. Proper ATX
headings ('# Title') carry a space after the hash and are unaffected; the
fix is always to rewrap so the '#' lands mid-line. Wired into ci.yml
(PR-time feedback), site.yml (fail in seconds instead of burning the
runner) and `just build site`.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOCS_DIR = REPO_ROOT / "docs"

# Line-start '#' glued to a digit — not a legal ATX heading, and the exact
# shape proven (2026-10-12 bisect on the wowsp docs tree) to hang lagrange.
LINE_START_HASH_DIGIT = re.compile(r"^#\d")


def main() -> int:
    violations: list[str] = []
    for path in sorted(DOCS_DIR.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if LINE_START_HASH_DIGIT.match(line):
                rel = path.relative_to(REPO_ROOT).as_posix()
                violations.append(f"{rel}:{lineno}: {line.strip()[:60]}")

    if violations:
        print(
            "error: markdown line(s) starting with '#<digits>' — lagrange's "
            "builder hangs on this shape (2026-10-09..12 site outage):",
            file=sys.stderr,
        )
        for entry in violations:
            print(f"  {entry}", file=sys.stderr)
        print(
            "Rewrap the paragraph so the '#' lands mid-line "
            "(proper '# Title' headings are fine).",
            file=sys.stderr,
        )
        return 1

    print("docs: no line-start '#<digits>' hazards")
    return 0


if __name__ == "__main__":
    sys.exit(main())
