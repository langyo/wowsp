#!/usr/bin/env python3
"""Ensure Tauri app icons exist, generating them from docs/logo.svg if missing.

Tauri's build script requires a platform icon set under
`packages/app/tauri/icons/` — `icon.ico` on Windows, `icon.icns` on macOS, plus
a range of PNGs for Linux. These are **build artifacts**, never source: they are
gitignored and regenerated from `docs/logo.svg` (the canonical logo) via
`cargo tauri icon`.

This script is idempotent: if `icon.ico` already exists, it does nothing.
Otherwise it regenerates the full icon set.

Requires the Tauri CLI (`cargo install tauri-cli` / `cargo tauri`).

Invoked by `just gen icons` (wired into `init`).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# Prefer the SVG, fall back to any logo.* present.
LOGO_CANDIDATES = [REPO_ROOT / "docs" / "logo.svg", REPO_ROOT / "docs" / "logo.webp"]

TAURI_PACKAGES = [REPO_ROOT / "packages" / "app" / "tauri"]
MARKER = "icon.ico"


def _info(msg: str) -> None:
    print(f"[tauri-icons] {msg}")


def _resolve_cargo() -> str | None:
    found = shutil.which("cargo")
    if found:
        return found
    try:
        if subprocess.run(["cargo", "--version"], capture_output=True).returncode == 0:
            return "cargo"
    except OSError:
        pass
    home = Path.home()
    for c in [
        home / ".cargo" / "bin" / "cargo.exe",
        home / ".cargo" / "bin" / "cargo",
        Path("/usr/local/cargo/bin/cargo"),
        Path("/usr/bin/cargo"),
    ]:
        if c.is_file():
            return str(c)
    env_cargo = os.environ.get("CARGO_HOME")
    if env_cargo:
        ch = Path(env_cargo) / "bin" / ("cargo.exe" if os.name == "nt" else "cargo")
        if ch.is_file():
            return str(ch)
    return None


def _tauri_cli() -> list[str] | None:
    cargo = _resolve_cargo()
    return [cargo, "tauri"] if cargo else None


def _package_ready(pkg: Path) -> bool:
    return (pkg / "icons" / MARKER).is_file()


def _find_logo() -> Path | None:
    for c in LOGO_CANDIDATES:
        if c.is_file():
            return c
    return None


def _generate(pkg: Path, logo: Path, tauri: list[str]) -> bool:
    icons_dir = pkg / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    _info(f"generating icon set for {pkg.name} from {logo.relative_to(REPO_ROOT)} ...")
    rc = subprocess.run([*tauri, "icon", str(logo)], cwd=pkg).returncode
    if rc != 0:
        _info(f"✗ tauri icon failed for {pkg.name} (exit {rc})")
        return False
    if not _package_ready(pkg):
        _info(f"✗ {pkg.name}/icons/{MARKER} still missing after generation")
        return False
    _info(f"✓ {pkg.name} icons ready")
    return True


def ensure() -> int:
    logo = _find_logo()
    if logo is None:
        _info(f"✗ logo source not found in {REPO_ROOT / 'docs'}")
        _info("  docs/logo.svg is the canonical icon source — add it to generate icons.")
        return 1

    tauri = _tauri_cli()
    if tauri is None:
        _info("✗ cargo (tauri CLI) not found on PATH")
        _info("  install with: cargo install tauri-cli")
        return 1

    missing = [p for p in TAURI_PACKAGES if not _package_ready(p)]
    if not missing:
        _info("all Tauri icon sets present — nothing to do")
        return 0

    for pkg in missing:
        if not _generate(pkg, logo, tauri):
            return 1
    return 0


def main() -> int:
    return ensure()


if __name__ == "__main__":
    sys.exit(main())
