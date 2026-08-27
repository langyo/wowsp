#!/usr/bin/env python3
"""Build BOTH WoWSP NSIS installers.

1. Standard build via ``cargo tauri build --bundles nsis`` — prompts users to
   fetch the bundled-WebView2 release when the runtime is missing.
2. Bundled-WebView2 variant: re-runs makensis over the *generated* script with
   ``/DWOWSP_WV2_PAYLOAD`` set; the template then embeds the Evergreen offline
   runtime installer and executes it during the gate (see installer.nsi).

The offline runtime (~180 MB) is cached under
``packages/app/tauri/installer/vendor/`` (gitignored).

    python scripts/build_installers.py [--skip-tauri-build]
"""

from __future__ import annotations

import argparse
import glob
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TAURI = REPO / "packages" / "app" / "tauri"
VENDOR = TAURI / "installer" / "vendor"
WV2_URL = "https://go.microsoft.com/fwlink/?linkid=2099617"
WV2_NAME = "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
TARGET = REPO / "target" / "release"


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
        subprocess.run(
            [curl, "-sL", "--retry", "3", "-o", str(tmp), WV2_URL],
            check=True,
        )
    else:
        urllib.request.urlretrieve(WV2_URL, tmp)  # follows the fwlink redirect
    if tmp.stat().st_size < 100 * 1024 * 1024 or tmp.read_bytes()[:2] != b"MZ":
        sys.exit(f"downloaded payload looks wrong: {tmp} ({tmp.stat().st_size} bytes)")
    tmp.replace(payload)
    print(f"[wv2] saved {payload.stat().st_size:,} bytes -> {payload}")
    return payload


def find_makensis() -> Path:
    hits = glob.glob(str(Path.home() / "AppData" / "Local" / "tauri" / "**" / "makensis.exe"), recursive=True)
    if not hits:
        sys.exit("makensis.exe not found under %LOCALAPPDATA%/tauri — run a `cargo tauri build --bundles nsis` first")
    return Path(sorted(hits)[-1])


def build_standard() -> Path:
    print("[std] cargo tauri build --bundles nsis …")
    subprocess.run(
        ["cargo", "tauri", "build", "--bundles", "nsis"],
        cwd=TAURI,
        check=True,
    )
    exe = TARGET / "bundle" / "nsis" / "WoWSP_0.1.0_x64-setup.exe"
    if not exe.is_file():
        sys.exit(f"standard bundle missing: {exe}")
    return exe


def build_bundled(payload: Path, makensis: Path) -> Path:
    src = TARGET / "nsis" / "x64" / "installer.nsi"
    script = src.read_text(encoding="utf-8")

    # The bundler compiles the generated script with a placeholder OUTFILE and
    # passes the real name on its own makensis invocation. For the variant we
    # hard-code the absolute output path instead.
    outfile = TARGET / "bundle" / "nsis" / "WoWSP_0.1.0_x64-setup-webview2.exe"
    script, n = re.subn(
        r'!define OUTFILE "[^"]*"',
        lambda _m: f'!define OUTFILE "{outfile}"',
        script,
        count=1,
    )
    if n != 1:
        sys.exit("could not patch OUTFILE in the generated NSIS script")

    variant = src.with_name("installer-webview2.nsi")
    variant.write_text(script, encoding="utf-8")

    print(f"[wv2] makensis (payload embedded from {payload.name}) …")
    subprocess.run(
        [
            str(makensis),
            f"/DWOWSP_WV2_PAYLOAD={payload}",
            str(variant),
        ],
        check=True,
        cwd=str(variant.parent),
    )
    exe = TARGET / "bundle" / "nsis" / "WoWSP_0.1.0_x64-setup-webview2.exe"
    if not exe.is_file():
        sys.exit(f"webview2 bundle missing: {exe}")
    return exe


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-tauri-build", action="store_true", help="reuse the existing generated NSIS script")
    args = ap.parse_args()

    payload = ensure_payload()
    if not args.skip_tauri_build:
        build_standard()
    else:
        print("[std] skipped cargo build (--skip-tauri-build)")

    makensis = find_makensis()
    bundled = build_bundled(payload, makensis)

    std = TARGET / "bundle" / "nsis" / "WoWSP_0.1.0_x64-setup.exe"
    for p in (std, bundled):
        print(f"[ok] {p.name}: {p.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
