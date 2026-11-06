#!/usr/bin/env python3
"""Preview/screenshot "junk" pruning for re-hosted Mod Hub packages.

The app-side installer already skips junk destinations (the Rust
`commands/mod_hub/junk.rs` predicate is the runtime authority), but the
resources served to users should not carry the material at all: Aslain-
ingested packs ship promo screenshots, preview folders and Explorer metadata
that inflate every download and land in a user's `res_mods` when an older
client installs them. This module is the PUBLISH-side twin of that predicate --
one rule shared by the manual publisher (`mod_hub_publish.py`) and the
scheduled sync engine (`mod_hub_sync.py`), which strip the members before a
package is ever zipped and uploaded.

Junk = an OS metadata file (`desktop.ini`, `Thumbs.db`, ...) or an IMAGE whose
basename or ANY path segment names a screenshot/preview marker (English or
Chinese). `.dds` and every non-image payload stay untouched: a functional HUD
or scene texture named normally never matches, and a marker-named `.dds` is a
real material reference.

`strip_zip_bytes` returns the original bytes UNCHANGED when a package carries
no junk (so junk-free assets keep their hashes and discussion lines), and a
deterministic re-zip otherwise (original member order, timestamps and
compression are preserved, so the same input always yields the same output).

Self-test: `python scripts/mod_package_hygiene.py --selftest` (offline).
"""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import PurePosixPath

# Explorer/OS metadata files that are never game payload.
JUNK_FILE_NAMES = {"desktop.ini", "thumbs.db", "ehthumbs.db", ".ds_store"}

# Image extensions a preview/screenshot can carry. ".dds" (the game's own
# texture format) is deliberately absent: a material named "screenshot.dds"
# is a real reference, not promo material.
JUNK_IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"}

# Lowercase path-segment markers that brand an image as junk. Matched against
# EVERY segment (directory or file), so "Screenshots/001.jpg" and
# "001_preview.jpg" both count.
JUNK_MARKERS = (
    "screenshot",
    "screenshots",
    "screen_shot",
    "screen-shot",
    "preview",
    "previews",
    "showcase",
    "thumbnail",
    "\u9884\u89c8",
    "\u622a\u56fe",
    "\u5ba3\u4f20\u56fe",
)


def _normalize(name: str) -> str:
    return name.replace("\\", "/").strip("/").lower()


def is_junk_rel(name: str) -> bool:
    """Is this (package-relative or res_mods-relative) path junk?

    Mirrors the Rust `is_junk_rel` predicate: either separator, optional
    `.bak` toggle suffix, lowercase comparison.
    """
    normalized = _normalize(name)
    if not normalized:
        return False
    bare = normalized[:-4] if normalized.endswith(".bak") else normalized
    basename = bare.rsplit("/", 1)[-1]
    if basename in JUNK_FILE_NAMES:
        return True
    if "." not in basename:
        return False
    ext = basename.rsplit(".", 1)[-1]
    if ext not in JUNK_IMAGE_EXTS:
        return False
    return any(marker in segment for segment in bare.split("/") for marker in JUNK_MARKERS)


def junk_members(names: list[str]) -> list[str]:
    """The junk subset of a member list (kept as a helper for reporting)."""
    return [name for name in names if is_junk_rel(name)]


def _dir_entries_to_drop(infos: list[zipfile.ZipInfo], junk: set[str]) -> set[str]:
    """Directory members that only existed for junk: drop them, keep every
    directory that still has a surviving member beneath it."""
    kept_files = [info.filename for info in infos
                  if info.filename not in junk and not info.is_dir()]
    kept_dirs = {str(PurePosixPath(path).parent)
                 for path in kept_files if str(PurePosixPath(path).parent) not in ("", ".")}
    # Every ancestor of a kept directory/file must survive too.
    for path in list(kept_dirs):
        parent = PurePosixPath(path).parent
        while str(parent) not in ("", "."):
            kept_dirs.add(str(parent))
            parent = parent.parent
    drop: set[str] = set()
    for info in infos:
        if not info.is_dir():
            continue
        name = info.filename.rstrip("/")
        if name not in kept_dirs:
            drop.add(info.filename)
    return drop


def strip_zip_bytes(data: bytes) -> tuple[bytes, int]:
    """Remove junk members from one zip container.

    Returns `(bytes, pruned)`: the ORIGINAL bytes when nothing matched (so
    clean assets keep their content address), otherwise a deterministic
    re-encoded zip. Only junk members (and directories left empty by their
    removal) go; member order, timestamps and compression are carried over.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as zin:
        infos = zin.infolist()
        junk = {info.filename for info in infos
                if not info.is_dir() and is_junk_rel(info.filename)}
        if not junk:
            return data, 0
        drop_dirs = _dir_entries_to_drop(infos, junk)
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in infos:
                if info.filename in junk or info.filename in drop_dirs:
                    continue
                payload = b"" if info.is_dir() else zin.read(info.filename)
                zout.writestr(info, payload)
        return out.getvalue(), len(junk)


def selftest() -> None:
    # Predicate: same truth table as the Rust authority.
    for name in [
        "screenshot.png", "Screenshot_2026.jpg", "gui/Screenshots/001.png",
        "gui/previews/scheme.webp", "showcase/a.gif", "thumbnail/a.bmp",
        "PnFMods/Showcase/preview.tiff", "\u9884\u89c8/1.png",
        "\u622a\u56fe\u52a0\u7fa4.png", "\u5ba3\u4f20\u56fe/abc.jpeg",
        "screen_shot_1.png", "screen-shot.jpg", "gui\\screenshots\\a.png",
        "gui/screenshots/a.png.bak", "desktop.ini", "gui/desktop.ini",
        "sub/Thumbs.db", ".DS_Store", "content/screenshots/texture.png",
    ]:
        assert is_junk_rel(name), name
    for name in [
        "gui/ribbons/ribbon.png", "spaces/PJSC001/tex.png",
        "content/gameplay/japan/ship/battleship/JSB039_Yamato_1945_Hull_a.dds",
        "content/unlocks/japan/camo.png", "gui/BFGC/BattleWave/battle.xml",
        "PnFMods/Skin/Main.py", "PnFModsLoader.py", "ime_config.xml",
        "banks/mods/\u8056\u5712\u30df\u30ab/mod.xml", "screenshot.dds",
        "gui/ribbons/ribbon.png.bak", "preview/readme.txt", "screenshots/notes.txt",
    ]:
        assert not is_junk_rel(name), name

    def build(members: dict[str, bytes]) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, payload in members.items():
                if name.endswith("/"):
                    zf.writestr(zipfile.ZipInfo(name), b"")
                else:
                    info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    zf.writestr(info, payload)
        return buf.getvalue()

    # A clean package is returned byte-identical (hash stability).
    clean = build({"PnFMods/Skin/Main.py": b"main", "PnFMods/Skin/tex.dds": b"dds"})
    assert strip_zip_bytes(clean) == (clean, 0)

    # Junk files and their now-empty folders go; functional siblings stay.
    dirty = build({
        "PnFMods/Skin/Main.py": b"main",
        "PnFMods/Skin/screenshot_1.png": b"shot",
        "PnFMods/Skin/screenshots/": b"",
        "PnFMods/Skin/screenshots/preview_2.jpg": b"prev",
        "gui/ribbons/ribbon.png": b"art",
        "desktop.ini": b"meta",
    })
    stripped, pruned = strip_zip_bytes(dirty)
    assert pruned == 3, pruned
    with zipfile.ZipFile(io.BytesIO(stripped)) as zf:
        names = set(zf.namelist())
    assert names == {"PnFMods/Skin/Main.py", "gui/ribbons/ribbon.png"}, names

    # Deterministic output: the same input yields the same bytes.
    again, pruned_again = strip_zip_bytes(dirty)
    assert pruned_again == 3 and again == stripped

    print("mod_package_hygiene selftest: ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        sys.exit("usage: mod_package_hygiene.py --selftest")