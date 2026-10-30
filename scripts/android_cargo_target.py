#!/usr/bin/env python3
"""Resolve an ASCII CARGO_TARGET_DIR for Android (APK) builds.

Why this exists (2026-10-30): the Android NDK's lld receives rustc's target
paths as GBK bytes on Windows and then cannot open them when the checkout
lives under a non-ASCII directory (the maintainer's D:\\源代码\\... tree) —
the link fails with "cannot find version script"/"cannot open ...rcgu.o".
AGP's own non-ASCII path check is disabled in gen/android/gradle.properties
(android.overridePathCheck=true); this script covers the Rust half by handing
every Android build an ASCII target directory.

Used by both entry points so they cannot drift:
  * the justfile's _build-android recipe (cargo tauri android build), and
  * gen/android/buildSrc/.../BuildTask.kt (Android Studio / Gradle), which
    mirrors the same candidate order.

Override with WOWSP_ANDROID_CARGO_TARGET. A candidate is accepted only when
its path is pure ASCII and it can be created; the first success wins. Prints
the directory (forward slashes) on stdout and exits 1 with a clear message
when nothing is available.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

OVERRIDE_ENV = "WOWSP_ANDROID_CARGO_TARGET"
DIR_NAME = "wowsp-android-target"


def _is_ascii(path: str) -> bool:
    try:
        path.encode("ascii")
    except UnicodeEncodeError:
        return False
    return True


def candidates() -> list[str]:
    """ASCII-writable target-directory candidates, in preference order."""
    out: list[str] = []
    override = os.environ.get(OVERRIDE_ENV, "").strip()
    if override:
        out.append(override)
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        out.append(str(Path(local_app_data) / "wowsp" / "android-target"))
    temp = (os.environ.get("TEMP") or os.environ.get("TMP") or "").strip()
    if temp:
        out.append(str(Path(temp) / DIR_NAME))
    if os.name == "nt":
        # Fallback that is ASCII and user-writable on every Windows box.
        out.append(rf"C:\Users\Public\{DIR_NAME}")
    else:
        out.append(f"/tmp/{DIR_NAME}")
    return out


def resolve() -> str:
    rejected: list[str] = []
    for candidate in candidates():
        if not _is_ascii(candidate):
            rejected.append(f"{candidate} (non-ASCII)")
            continue
        directory = Path(candidate)
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            rejected.append(f"{candidate} ({exc})")
            continue
        return directory.as_posix()
    detail = "; ".join(rejected) if rejected else "no candidates"
    raise SystemExit(
        "android_cargo_target: no ASCII-writable target directory for the Android build "
        f"({detail}). Set {OVERRIDE_ENV} to an ASCII path (the NDK lld cannot handle "
        "non-ASCII paths)."
    )


def main() -> int:
    print(resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
