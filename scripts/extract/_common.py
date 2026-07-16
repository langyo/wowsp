"""Shared helpers for WoWSP game-asset extraction scripts.

Locates the game install and the `wowsunpack` binary, and provides convenience
runners for the two wowsunpack subcommands these scripts rely on
(`game-params` → GameParams.json, `metadata` → the path/size map used by the
.pkg PNG slicer).

Game detection order (mirrors the Rust game_detect logic in
`packages/app/tauri/src/commands/game_detect.rs`):
  1. explicit `path` argument / WOWSP_GAME_PATH env var
  2. Steam appmanifest_552990.acf across every library in libraryfolders.vdf
  3. registry scan for Wargaming/Lesta/360 publishers (Windows-only)

wowsunpack location order:
  1. WOWSP_WOWSUNPACK env var
  2. PATH (`shutil.which`)
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

STEAM_APPID = "552990"


def find_game_path(explicit: str | None = None) -> str | None:
    """Return the directory containing WorldOfWarships.exe, or None."""
    env_or_arg = explicit or os.environ.get("WOWSP_GAME_PATH")
    if env_or_arg and Path(env_or_arg, "WorldOfWarships.exe").is_file():
        return env_or_arg

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

    for path in _registry_scan():
        return path
    return None


def find_wowsunpack() -> str | None:
    env = os.environ.get("WOWSP_WOWSUNPACK")
    if env and Path(env).is_file():
        return env
    return shutil.which("wowsunpack") or shutil.which("wowsunpack.exe")


def latest_bin_with_idx(game_path: str) -> Path | None:
    """The newest bin/<build>/ that actually ships an idx/ directory.

    Steam installs can hold several builds; only some carry the index files
    wowsunpack needs. Pick the highest-numbered build that has idx/.
    """
    bin_dir = Path(game_path, "bin")
    if not bin_dir.is_dir():
        return None
    candidates = [d for d in bin_dir.iterdir() if d.is_dir() and (d / "idx").is_dir()]
    if not candidates:
        return None
    candidates.sort(key=lambda d: _try_int(d.name), reverse=True)
    return candidates[0]


def run_wowsunpack(args: list[str]) -> int:
    exe = find_wowsunpack()
    if not exe:
        raise SystemExit(
            "wowsunpack not found. Install it (cargo install wowsunpack) or set "
            "WOWSP_WOWSUNPACK=/path/to/wowsunpack."
        )
    cmd = [exe, *args]
    print(f"[wowsunpack] $ {' '.join(cmd)}")
    return subprocess.call(cmd)


def run_game_params(out_json: Path, game_path: str) -> int:
    """Dump content/GameParams.data → JSON via wowsunpack game-params."""
    return run_wowsunpack(["--game-dir", game_path, "game-params", str(out_json)])


def run_metadata(out_json: Path, game_path: str) -> int:
    """Dump the full pkg path/size index via wowsunpack metadata."""
    return run_wowsunpack(["--game-dir", game_path, "metadata", str(out_json), "--format", "json"])


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
            val = line[len('"path"'):].strip().strip('"').replace("\\\\", "\\")
            if val:
                roots.append(Path(val))
    return roots


def _vdf_value(text: str, key: str) -> str | None:
    needle = f'"{key}"'
    for line in text.splitlines():
        line = line.strip()
        if line.startswith(needle):
            return line[len(needle):].strip().strip('"').replace("\\\\", "\\")
    return None


def _try_int(s: str) -> int:
    try:
        return int(s)
    except ValueError:
        return 0


def _registry_scan() -> list[str]:
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
