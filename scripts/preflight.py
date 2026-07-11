#!/usr/bin/env python3
"""Environment preflight checker for WoWSP.

Adapted from shittim-chest's `scripts/preflight.py` (heavily trimmed — WoWSP
has no Docker/WSL2/fuse-overlayfs requirements). Verifies the dev tools WoWSP
actually needs are present BEFORE a build step fails, with one actionable hint
per missing tool.

Usage:
    python scripts/preflight.py              # check all
    python scripts/preflight.py node pnpm    # check only listed tools
    python scripts/preflight.py --json       # machine-readable
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys


def _ver(cmd: str) -> str | None:
    # On Windows, package managers (pnpm/npm) are often .cmd/.ps1 shims that
    # shutil.which can miss depending on PATHEXT. Try shutil.which first, then
    # a bare invocation that trusts the parent shell's PATH.
    exe = shutil.which(cmd)
    if exe:
        try:
            out = subprocess.run([cmd, "--version"], capture_output=True, text=True, timeout=5)
            if out.returncode == 0:
                return (out.stdout or out.stderr).strip().splitlines()[0]
        except Exception:
            pass
    # Bare-name probe: trusts the parent shell's resolution (works for shims).
    # On Windows, .cmd/.ps1 shims (pnpm) need shell=True to resolve.
    try:
        out = subprocess.run(
            f'"{cmd}" --version',
            capture_output=True,
            text=True,
            timeout=5,
            shell=True,
        )
        if out.returncode == 0:
            return (out.stdout or out.stderr).strip().splitlines()[0]
    except Exception:
        return None
    return None


# (name, human-readable purpose, remediation hint)
TOOLS = [
    ("rustc", "Rust compiler (>= 1.85)", "install via https://rustup.rs"),
    ("cargo", "Rust build tool", "install via https://rustup.rs"),
    ("node", "Node.js (>= 20)", "install LTS from https://nodejs.org"),
    ("pnpm", "package manager (>= 9)", "corepack enable && corepack prepare pnpm@latest --activate"),
    ("python", "Python (>= 3.11)", "install from https://python.org"),
    ("just", "command runner", "cargo install just"),
    ("git", "version control", "install from https://git-scm.com"),
]


def check(names: list[str]) -> list[dict]:
    sel = names or [n for n, _, _ in TOOLS]
    results: list[dict] = []
    for name, purpose, hint in TOOLS:
        if name not in sel:
            continue
        ver = _ver(name)
        results.append({"name": name, "purpose": purpose, "ok": ver is not None, "version": ver, "hint": hint})
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="WoWSP dev environment preflight")
    parser.add_argument("tools", nargs="*", help="tools to check (default: all)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    results = check(args.tools)
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        for r in results:
            mark = "OK  " if r["ok"] else "MISS"
            ver = r["version"] or ""
            print(f"  [{mark}] {r['name']:<8} {ver:<30} {r['purpose']}")
            if not r["ok"]:
                print(f"           -> {r['hint']}")

    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
