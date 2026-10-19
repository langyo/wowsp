#!/usr/bin/env python3
"""Single source of truth for the release version: the root package.json.

`python scripts/sync_versions.py`          propagate the root version into
                                           every derived slot (write mode)
`python scripts/sync_versions.py --check`  verify agreement, write nothing
                                           (the CI gate, formerly
                                           scripts/check_versions.py)

Edit the version in ONE place — the root `package.json` — then run the
script and commit the touched manifests together (AGENTS.md §5).

Derived slots (all must equal the root version):
  - Cargo.toml                            [workspace.package] version
  - packages/app/tauri/tauri.conf.json    version
  - packages/webui/package.json           version
  - packages/website/package.json         version
  - packages/holo/package.json            version
  - packages/pairing-relay/wrangler.toml  [vars] FEEDBACK_LATEST_VERSION
    (the /feedback form's browser-side version default; it deploys only
    when the worker is re-deployed, so drift here ships a stale default
    silently)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ImportError:  # pragma: no cover
    print("error: tomllib requires Python 3.11+", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parent.parent
ROOT_PACKAGE = REPO_ROOT / "package.json"

# label, path, formatter of the exact line carrying the version
TARGETS: list[tuple[str, str, str]] = [
    ("Cargo.toml [workspace.package]", "Cargo.toml", "toml"),
    ("tauri.conf.json", "packages/app/tauri/tauri.conf.json", "json"),
    ("packages/webui/package.json", "packages/webui/package.json", "json"),
    ("packages/website/package.json", "packages/website/package.json", "json"),
    ("packages/holo/package.json", "packages/holo/package.json", "json"),
    ("pairing-relay wrangler.toml [vars]", "packages/pairing-relay/wrangler.toml", "wrangler"),
]

SEMVER = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?")
VERSION_LINE = {
    "json": re.compile(r'^(\s*"version":\s*")([^"]+)(",?)$'),
    "toml": re.compile(r'^(version\s*=\s*")([^"]+)("\s*)$'),
    "wrangler": re.compile(r'^(FEEDBACK_LATEST_VERSION\s*=\s*")([^"]+)("\s*)$'),
}


def root_version() -> str:
    version = json.loads(ROOT_PACKAGE.read_text(encoding="utf-8")).get("version")
    if not version or not SEMVER.fullmatch(str(version)):
        print(f"error: root package.json has no usable version field: {version!r}", file=sys.stderr)
        sys.exit(2)
    return str(version)


def current_version(rel_path: str, kind: str) -> str:
    """Read the derived slot's version (toml slots need section awareness)."""
    path = REPO_ROOT / rel_path
    if not path.is_file():
        print(f"error: missing file {rel_path}", file=sys.stderr)
        sys.exit(2)
    text = path.read_text(encoding="utf-8")
    if kind == "toml":
        data = tomllib.loads(text)
        version = data.get("workspace", {}).get("package", {}).get("version")
    elif kind == "wrangler":
        version = tomllib.loads(text).get("vars", {}).get("FEEDBACK_LATEST_VERSION")
    else:
        version = json.loads(text).get("version")
    if not version:
        print(f"error: no version field in {rel_path}", file=sys.stderr)
        sys.exit(2)
    return str(version)


def rewrite(rel_path: str, kind: str, new_version: str) -> bool:
    """Replace the version value in place; return True if the file changed.

    Surgical: only the matched line's value is swapped, so each manifest
    keeps its formatting, key order and comments byte-for-byte.
    """
    path = REPO_ROOT / rel_path
    text = path.read_text(encoding="utf-8", newline="")
    pattern = VERSION_LINE[kind]

    lines = text.splitlines(keepends=True)
    hits: list[int] = []
    if kind == "toml":
        in_section = False
        for i, line in enumerate(lines):
            if line.startswith("["):
                in_section = line.strip() == "[workspace.package]"
                continue
            if in_section and pattern.match(line.rstrip("\r\n")):
                hits.append(i)
    else:
        hits = [i for i, line in enumerate(lines) if pattern.match(line.rstrip("\r\n"))]
    if len(hits) != 1:
        print(f"error: {rel_path}: expected exactly one version line, found {len(hits)}", file=sys.stderr)
        sys.exit(2)

    i = hits[0]
    m = pattern.match(lines[i].rstrip("\r\n"))
    assert m is not None
    eol = "\r\n" if lines[i].endswith("\r\n") else "\n"
    lines[i] = f"{m.group(1)}{new_version}{m.group(3)}{eol}"
    result = "".join(lines)

    # The written manifest must still parse and carry the new version.
    if result != text:
        path.write_text(result, encoding="utf-8", newline="")
        got = current_version(rel_path, kind)
        if got != new_version:
            print(f"error: {rel_path}: wrote {new_version!r} but read back {got!r}", file=sys.stderr)
            sys.exit(2)
    return result != text


def main() -> int:
    check_only = "--check" in sys.argv[1:]
    version = root_version()
    got_versions = [current_version(rel, kind) for _, rel, kind in TARGETS]

    width = max(len(label) for label, _, _ in TARGETS)
    print(f"{'package.json (root, source of truth)'.ljust(width)}  {version}")
    for (label, _, _), got in zip(TARGETS, got_versions):
        print(f"{label.ljust(width)}  {got}")

    drifted = [label for (label, _, _), got in zip(TARGETS, got_versions) if got != version]
    if not drifted:
        print(f"\nAll {len(got_versions) + 1} version fields agree: {version}")
        return 0

    print(
        "\nerror: version drift in: " + ", ".join(drifted),
        file=sys.stderr,
    )
    if check_only:
        print(
            "run `python scripts/sync_versions.py` locally and commit the "
            "touched manifests (AGENTS.md §5)",
            file=sys.stderr,
        )
        return 1
    changed = []
    for (label, rel, kind), got in zip(TARGETS, got_versions):
        if got != version:
            rewrite(rel, kind, version)
            changed.append(f"{label}: {got} -> {version}")
    print("\nsynced:\n  " + "\n  ".join(changed))
    print("commit the touched manifests together with the root bump (AGENTS.md §5)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
