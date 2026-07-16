#!/usr/bin/env python3
"""Sync the project logo from docs/logo.webp to all icon assets.

Compares the source logo (docs/logo.webp) against the installed copy
(packages/webui/src/res/logo.webp). If they differ (user updated the logo),
regenerates all icon assets via generate_icons.py. Run at dev start so a
logo change is picked up automatically — no manual `just gen-icons` needed.

Usage:
    python scripts/sync_logo.py           # sync if needed
    python scripts/sync_logo.py --check   # exit 1 if out of sync (CI mode)
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "logo.webp"
INSTALLED = ROOT / "packages" / "webui" / "src" / "res" / "logo.webp"
# Sidecar file that records the source hash from the last sync. We can't
# compare source vs installed directly because generate_icons.py re-encodes
# the WebP (different bytes even for identical pixels).
HASH_FILE = ROOT / "packages" / "webui" / "src" / "res" / ".logo-source-hash"


def file_hash(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.md5(path.read_bytes()).hexdigest()


def main() -> int:
    check_only = "--check" in sys.argv

    if not SOURCE.exists():
        print(f"[sync_logo] source not found: {SOURCE}", file=sys.stderr)
        return 1

    src_hash = file_hash(SOURCE)
    last_synced = HASH_FILE.read_text().strip() if HASH_FILE.exists() else None

    if src_hash == last_synced:
        return 0  # in sync

    if check_only:
        print("[sync_logo] logo out of sync — run `just gen-icons` to update")
        return 1

    print(f"[sync_logo] logo changed, regenerating icons...")
    import subprocess
    rc = subprocess.call(
        [sys.executable, str(ROOT / "scripts" / "generate_icons.py"), str(SOURCE)],
        cwd=str(ROOT),
    )
    if rc == 0:
        # Record the source hash so we don't regenerate next time.
        HASH_FILE.parent.mkdir(parents=True, exist_ok=True)
        HASH_FILE.write_text(src_hash)
        print("[sync_logo] done — all icons regenerated")
    else:
        print(f"[sync_logo] generate_icons.py failed (rc={rc})", file=sys.stderr)
    return rc


if __name__ == "__main__":
    sys.exit(main())
