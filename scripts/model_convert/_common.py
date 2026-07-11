"""Shared helpers for WoWSP model converters: locate the game install (mirroring
the Rust game_detect logic) and the `wowsunpack` binary.

Game detection order:
  1. WOWSP_GAME_PATH env var (explicit override)
  2. Steam appmanifest_552990.acf across every library in libraryfolders.vdf
  3. (registry scan for Wargaming/Lesta/360 publishers — Windows-only)

wowsunpack location order:
  1. WOWSP_WOWSUNPACK env var
  2. PATH (`shutil.which`)
"""
from __future__ import annotations

import os
import shutil
import struct
import subprocess
from pathlib import Path


STEAM_APPID = "552990"


def find_game_path() -> str | None:
    """Return the directory containing WorldOfWarships.exe, or None."""
    env = os.environ.get("WOWSP_GAME_PATH")
    if env and Path(env, "WorldOfWarships.exe").is_file():
        return env

    # Steam: walk libraryfolders.vdf for every library root, then look for the
    # appmanifest in <lib>/steamapps/.
    for steam in _steam_roots():
        vdf = steam / "steamapps" / "libraryfolders.vdf"
        if not vdf.is_file():
            continue
        libs = _parse_library_paths(vdf.read_text(encoding="utf-8", errors="ignore"))
        libs.insert(0, steam)
        for lib in libs:
            acf = lib / "steamapps" / f"appmanifest_{STEAM_APPID}.acf"
            if not acf.is_file():
                continue
            installdir = _vdf_value(acf.read_text(encoding="utf-8", errors="ignore"), "installdir")
            if not installdir:
                continue
            root = lib / "steamapps" / "common" / installdir
            if (root / "WorldOfWarships.exe").is_file():
                return str(root)

    # Registry scan (Wargaming/Lesta/360 publishers) — Windows only.
    for path in _registry_scan():
        return path
    return None


def find_wowsunpack() -> str | None:
    env = os.environ.get("WOWSP_WOWSUNPACK")
    if env and Path(env).is_file():
        return env
    found = shutil.which("wowsunpack") or shutil.which("wowsunpack.exe")
    return found


def run_wowsunpack(args: list[str]) -> int:
    """Invoke wowsunpack with the given args (no --game-dir; caller adds it).
    Streams output to the console. Returns the exit code."""
    exe = find_wowsunpack()
    if not exe:
        raise SystemExit(
            "wowsunpack not found. Install it (cargo install wowsunpack) or set "
            "WOWSP_WOWSUNPACK=/path/to/wowsunpack. See scripts/model_convert/README.md."
        )
    cmd = [exe, *args]
    print(f"[model_convert] $ {' '.join(cmd)}")
    return subprocess.call(cmd)


def _steam_roots() -> list[Path]:
    candidates = [
        Path(r"C:\Program Files (x86)\Steam"),
        Path(r"C:\Program Files\Steam"),
    ]
    return [c for c in candidates if (c / "steamapps").is_dir()]


def _parse_library_paths(vdf_text: str) -> list[Path]:
    roots: list[Path] = []
    for line in vdf_text.splitlines():
        line = line.strip()
        if line.startswith('"path"'):
            val = line[len('"path"') :].strip().strip('"').replace("\\\\", "\\")
            if val:
                roots.append(Path(val))
    return roots


def _vdf_value(text: str, key: str) -> str | None:
    needle = f'"{key}"'
    for line in text.splitlines():
        line = line.strip()
        if line.startswith(needle):
            return line[len(needle) :].strip().strip('"').replace("\\\\", "\\")
    return None


def _registry_scan() -> list[str]:
    # Mirrors the Rust winreg scan; returns at most one hit for simplicity.
    try:
        import winreg  # type: ignore
    except ImportError:
        return []
    publishers = {"Wargaming.net", "Wargaming Group Limited", "360.cn", "Lesta Games"}
    hits: list[str] = []
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for sub in (
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ):
            try:
                key = winreg.OpenKey(hive, sub)
            except OSError:
                continue
            i = 0
            while True:
                try:
                    child = winreg.EnumKey(key, i)
                    i += 1
                except OSError:
                    break
                try:
                    with winreg.OpenKey(key, child) as ck:
                        pub = winreg.QueryValueEx(ck, "Publisher")[0]
                        if pub not in publishers:
                            continue
                        loc = winreg.QueryValueEx(ck, "InstallLocation")[0]
                        if loc and Path(loc, "WorldOfWarships.exe").is_file():
                            hits.append(loc)
                except OSError:
                    continue
    return hits


# Silence unused-import warnings for struct (kept for future .pkg header work).
_ = struct
