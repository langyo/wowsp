#!/usr/bin/env python3
"""Build the WoWSP shun installer artifacts.

1. Build the application (``cargo tauri build --no-bundle``) and stage its
   executable as the installer payload.
2. Build the installer shell with ``SHUN_PAYLOAD`` pointing at the staging
   directory — the payload is packed into the shell binary (the single-file
   installer pattern; see packages/installer-shell/build.rs).
3. Emit both delivery artifacts under ``target/release/bundle/installer/``:

   - ``WoWSP_<version>_x64-installer.exe`` — needs the system WebView2
     runtime (the shell falls back to the releases page without it), and
   - ``WoWSP_<version>_x64-installer-webview2.zip`` — the installer paired
     with the Evergreen offline runtime; the shell runs the offline
     installer beside it when the runtime is missing.

The offline runtime (~180 MB) is cached under
``packages/installer-shell/vendor/`` (gitignored).

    python scripts/build_installers.py [--skip-app-build] [--skip-shell-build]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TAURI = REPO / "packages" / "app" / "tauri"
SHELL = REPO / "packages" / "installer-shell"
VENDOR = SHELL / "vendor"
WV2_URL = "https://go.microsoft.com/fwlink/?linkid=2099617"
WV2_NAME = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
TARGET = REPO / "target" / "release"
OUT = TARGET / "bundle" / "installer"


def app_version() -> str:
    raw = (REPO / "package.json").read_text(encoding="utf-8")
    return json.loads(raw)["version"]


def run(cmd: list[str], **kwargs) -> None:
    print(f"[run] {' '.join(str(c) for c in cmd)}")
    subprocess.run([str(c) for c in cmd], check=True, **kwargs)


def build_app() -> Path:
    print("[app] building webui + wowsp_tauri (release) …")
    run(["pnpm", "--filter", "@wowsp/webui", "build"])
    run(["cargo", "build", "-p", "wowsp_tauri", "--release"])
    exe = TARGET / "wowsp.exe"
    if not exe.is_file():
        sys.exit(f"application binary missing: {exe}")
    return exe


def stage_payload(app_exe: Path) -> Path:
    stage = TARGET / "installer-stage"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    shutil.copy2(app_exe, stage / app_exe.name)
    print(f"[stage] payload: {stage} ({app_exe.name})")
    return stage


def build_installer(stage: Path) -> Path:
    print("[installer] cargo build -p wowsp_installer_shell --release …")
    env = {**os.environ, "SHUN_PAYLOAD": str(stage)}
    subprocess.run(
        ["cargo", "build", "-p", "wowsp_installer_shell", "--release"],
        check=True,
        env=env,
    )
    exe = TARGET / "wowsp-installer.exe"
    if not exe.is_file():
        sys.exit(f"installer binary missing: {exe}")
    return exe


def ensure_payload() -> Path:
    VENDOR.mkdir(parents=True, exist_ok=True)
    payload = VENDOR / WV2_NAME
    if payload.is_file() and payload.stat().st_size > 100 * 1024 * 1024:
        print(f"[wv2] cached payload: {payload}")
        return payload
    print(f"[wv2] downloading Evergreen x64 offline installer ({WV2_URL}) …")
    tmp = payload.with_suffix(".part")
    # curl is dramatically faster than urllib on some Windows setups
    # (observed 10 MB/s vs 25 KB/s through the same fwlink) — prefer it.
    curl = shutil.which("curl")
    if curl:
        run([curl, "-sL", "--retry", "3", "-o", tmp, WV2_URL])
    else:
        urllib.request.urlretrieve(WV2_URL, tmp)  # follows the fwlink redirect
    if tmp.stat().st_size < 100 * 1024 * 1024 or tmp.read_bytes()[:2] != b"MZ":
        sys.exit(f"downloaded payload looks wrong: {tmp} ({tmp.stat().st_size} bytes)")
    tmp.replace(payload)
    print(f"[wv2] saved {payload.stat().st_size:,} bytes -> {payload}")
    return payload


def emit(version: str, installer: Path, wv2: Path | None) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    main = OUT / f"WoWSP_{version}_x64-installer.exe"
    shutil.copy2(installer, main)
    print(f"[ok] {main.name}: {main.stat().st_size:,} bytes")
    if wv2:
        zip_path = OUT / f"WoWSP_{version}_x64-installer-webview2.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(installer, installer.name)
            zf.write(wv2, WV2_NAME)
        print(f"[ok] {zip_path.name}: {zip_path.stat().st_size:,} bytes")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-app-build", action="store_true", help="reuse target/release/wowsp.exe")
    ap.add_argument("--skip-shell-build", action="store_true", help="reuse target/release/wowsp-installer.exe")
    args = ap.parse_args()

    version = app_version()

    app_exe = TARGET / "wowsp.exe"
    if args.skip_app_build:
        if not app_exe.is_file():
            sys.exit(f"--skip-app-build but {app_exe} is missing")
        print("[app] skipped cargo build (--skip-app-build)")
    else:
        app_exe = build_app()
    stage = stage_payload(app_exe)

    installer = TARGET / "wowsp-installer.exe"
    if args.skip_shell_build:
        if not installer.is_file():
            sys.exit(f"--skip-shell-build but {installer} is missing")
        print("[installer] skipped cargo build (--skip-shell-build)")
    else:
        installer = build_installer(stage)

    wv2 = ensure_payload()
    emit(version, installer, wv2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
