#!/usr/bin/env python3
"""Fail on version drift across the manifests that must move together.

Enforces AGENTS.md §5: a version bump rides in the feature PR itself and
must update every field below in one sweep. The release workflow tags from
the Tauri config version, so silent drift between these files ships a
mismatched app/site bundle.

Checked fields (all must be equal):
  - Cargo.toml                → [workspace.package] version
  - packages/app/tauri/tauri.conf.json → version
  - package.json              → version (root)
  - packages/{webui,website,holo}/package.json → version
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ImportError:  # pragma: no cover
    print("error: tomllib requires Python 3.11+", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parent.parent

SOURCES: list[tuple[str, str]] = [
    ("Cargo.toml [workspace.package]", "Cargo.toml"),
    ("tauri.conf.json", "packages/app/tauri/tauri.conf.json"),
    ("package.json (root)", "package.json"),
    ("packages/webui/package.json", "packages/webui/package.json"),
    ("packages/website/package.json", "packages/website/package.json"),
    ("packages/holo/package.json", "packages/holo/package.json"),
]


def read_version(label: str, rel_path: str) -> str:
    path = REPO_ROOT / rel_path
    if not path.is_file():
        print(f"error: {label}: missing file {rel_path}", file=sys.stderr)
        sys.exit(2)
    if path.suffix == ".toml":
        with path.open("rb") as fh:
            data = tomllib.load(fh)
        version = data.get("workspace", {}).get("package", {}).get("version")
    else:
        version = json.loads(path.read_text(encoding="utf-8")).get("version")
    if not version:
        print(f"error: {label}: no version field in {rel_path}", file=sys.stderr)
        sys.exit(2)
    return str(version)


def main() -> int:
    rows = [(label, read_version(label, rel)) for label, rel in SOURCES]
    versions = {v for _, v in rows}
    width = max(len(label) for label, _ in rows)
    for label, version in rows:
        print(f"{label.ljust(width)}  {version}")
    if len(versions) != 1:
        print(
            "\nerror: version drift detected — bump all listed files together "
            "in the same PR (AGENTS.md §5)",
            file=sys.stderr,
        )
        return 1
    print(f"\nAll {len(rows)} version fields agree: {rows[0][1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
