#!/usr/bin/env python3
"""Build the WoWSP shun installer artifacts.

1. Build the application and stage its executable as the installer payload.
2. Build the installer shell once per flavor with ``SHUN_PAYLOAD`` pointing
   at the staged directory (the payload is packed into the shell binary —
   the single-file installer pattern; see packages/installer-shell/build.rs):

   - ``lite``     — application only (the done pane offers the model-pack
     attachment download instead),
   - ``full``     — application + the 2D/3D model pack, and
   - ``*-webview2`` — each flavor with the Evergreen offline runtime
     embedded for machines without the WebView2 runtime.

Artifacts land in ``target/release/bundle/installer/`` as
``WoWSP_<version>_x64-installer[-full][-webview2].exe``.

The Evergreen offline runtime (~180 MB) is cached under
``packages/installer-shell/vendor/`` (gitignored).

    python scripts/build_installers.py [--skip-app-build] [--skip-models] [--flavors ...]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TAURI = REPO / "packages" / "app" / "tauri"
SHELL = REPO / "packages" / "installer-shell"
MODELS = REPO / "packages" / "webui" / "src" / "res" / "models"
VENDOR = SHELL / "vendor"
WV2_URL = "https://go.microsoft.com/fwlink/?linkid=2099617"
WV2_NAME = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
WV2_PAYLOAD_PREFIX = "webview2"
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
    # pnpm ships as a .cmd shim on Windows — subprocess needs the resolved
    # path (bare "pnpm" fails CreateProcess's extension-less lookup).
    pnpm = shutil.which("pnpm") or "pnpm"
    run([pnpm, "--filter", "@wowsp/webui", "build"])
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


def stage_models(stage: Path) -> None:
    """Stage the baked model pack (2D/3D resources) into the payload. The
    shell relocates it into the app's model-pack cache after extraction, so
    a fresh install has ships/maps/planes models without touching the
    network."""
    dest = stage / "models"
    shutil.copytree(MODELS, dest)
    print(f"[stage] model pack: {dest}")


def build_installer(stage: Path, env_extra: dict[str, str] | None = None) -> Path:
    label = "bare" if not env_extra else "webview2"
    print(f"[installer:{label}] cargo build -p wowsp_installer_shell --release …")
    env = {
        **os.environ,
        "SHUN_PAYLOAD": str(stage),
        # The multi-hundred-MB embedded payload defeats LTO (the link step
        # fail-fasts with STATUS_STACK_BUFFER_OVERRUN under thin LTO) and
        # gains nothing from it; skip LTO and any rustc wrapper cache.
        "CARGO_PROFILE_RELEASE_LTO": "off",
        "RUSTC_WRAPPER": "",
        **(env_extra or {}),
    }
    subprocess.run(
        ["cargo", "build", "-p", "wowsp_installer_shell", "--release"],
        check=True,
        env=env,
    )
    exe = TARGET / "wowsp-installer.exe"
    if not exe.is_file():
        sys.exit(f"installer binary missing: {exe}")
    return exe


def stage_webview2(stage: Path, wv2: Path) -> Path:
    """Copy the offline runtime into the staging tree under ``webview2/`` —
    the payload-relative prefix the shell extracts it from."""
    dest = stage / WV2_PAYLOAD_PREFIX
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy2(wv2, dest / WV2_NAME)
    return stage


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


def emit(version: str, installer: Path, suffix: str) -> Path:
    """Copies a freshly built installer into the artifact name. Called right
    after each variant's build: the second build overwrites the shared
    target/release/wowsp-installer.exe, so the bare copy must land on disk
    before the webview2 build starts."""
    OUT.mkdir(parents=True, exist_ok=True)
    artifact = OUT / f"WoWSP_{version}_x64-installer{suffix}.exe"
    shutil.copy2(installer, artifact)
    print(f"[ok] {artifact.name}: {artifact.stat().st_size:,} bytes")
    return artifact


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-app-build", action="store_true", help="reuse target/release/wowsp.exe")
    ap.add_argument("--skip-models", action="store_true", help="omit the 2D/3D model pack (~1.2 GB) from the payload (lite artifacts only)")
    ap.add_argument(
        "--flavors",
        default="lite,lite-webview2,full,full-webview2",
        help="comma list of artifacts to build: lite, lite-webview2, full, full-webview2",
    )
    args = ap.parse_args()

    flavors = [f.strip() for f in args.flavors.split(",") if f.strip()]
    if args.skip_models and any("full" in f for f in flavors):
        sys.exit("--skip-models is incompatible with the full flavors")

    version = app_version()

    app_exe = TARGET / "wowsp.exe"
    if args.skip_app_build:
        if not app_exe.is_file():
            sys.exit(f"--skip-app-build but {app_exe} is missing")
        print("[app] skipped cargo build (--skip-app-build)")
    else:
        app_exe = build_app()

    # One shared staging directory, re-staged just-in-time before each
    # flavor pair: lite (application only) vs full (application + model
    # pack). Staging everything up front would let the full payload bleed
    # into the lite builds — both flavors pack the same path.
    wv2 = ensure_payload()

    def build_variant(stage: Path, with_wv2: bool, suffix: str) -> None:
        if with_wv2:
            stage = stage_webview2(stage, wv2)
        exe = build_installer(stage)
        # Copy right after the build: the next variant overwrites the
        # shared output binary.
        emit(version, exe, suffix)

    lite_flavors = [f for f in flavors if f.startswith("lite")]
    full_flavors = [f for f in flavors if f.startswith("full")]

    if lite_flavors:
        lite_stage = stage_payload(app_exe)
        if "lite" in flavors:
            build_variant(lite_stage, False, "")
        if "lite-webview2" in flavors:
            build_variant(lite_stage, True, "-webview2")

    if full_flavors:
        full_stage = stage_payload(app_exe)
        stage_models(full_stage)
        if "full" in flavors:
            build_variant(full_stage, False, "-full")
        if "full-webview2" in flavors:
            build_variant(full_stage, True, "-full-webview2")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
