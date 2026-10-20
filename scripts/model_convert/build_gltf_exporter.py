#!/usr/bin/env python3
"""Build the vendored wows-model-exporter into target/model-tools/.

Drives CMake + MSVC over `packages/tools/wows-model-exporter-vendor`
(the tracked-in-tree upstream-0.2.1 fork — see its README.md for the
WoWSP patches). vcpkg lives under `target/vcpkg` and is bootstrapped on
first use; the CMake build dir goes to the temp folder because CMake
4.x crashes when its working directory sits under a non-ASCII path.

Usage:
    just build gltf-exporter        (or: python scripts/model_convert/build_gltf_exporter.py)
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
VENDOR = REPO_ROOT / "packages" / "tools" / "wows-model-exporter-vendor"
TOOLS = REPO_ROOT / "target" / "model-tools"
# vcpkg CANNOT live under the repo: its buildtrees/logs break on non-ASCII
# paths (a repo like D:\源代码\... mangles vcpkg's own log-file writes), so
# it parks in an ASCII-safe per-user location instead.
VCPKG = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".local" / "share"))) / "wowsp" / "vcpkg"

VCPKG_GIT = "https://github.com/microsoft/vcpkg.git"
# The vcpkg commit upstream 0.2.1 pins in its deps/vcpkg submodule — the
# port set the exporter's manifest was written against (a fresh vcpkg
# master builds a python3 that fails its ZLIB glue). Pinned + no
# builtin-baseline in the manifest = classic resolution from this
# checkout's ports tree.
VCPKG_PIN = "e5a4f54c0d562059e9ccc6f7e7150667da58fe41"
BUILD_DIR = Path(tempfile.gettempdir()) / "wowsp-gltf-exporter-build"

BINARIES = ["wows-gltf-exporter.exe", "wows-list-ships.exe", "wows-geometry-cli.exe", "wows-geometry.dll"]


def _git_proxy_env() -> dict[str, str]:
    """Inherit git's configured proxy for the child downloads — vcpkg's
    fetches (cmake tool, port sources) honor http_proxy/https_proxy, and
    on machines where only git reaches GitHub that is the difference
    between working and timing out."""
    env = dict(os.environ)
    try:
        proxy = subprocess.run(["git", "config", "--global", "--get", "https.proxy"],
                               capture_output=True, text=True).stdout.strip()
        if proxy and "http_proxy" not in env and "https_proxy" not in env:
            env["http_proxy"] = proxy
            env["https_proxy"] = proxy
            print(f"[gltf-exporter] inheriting git proxy {proxy} for vcpkg downloads")
    except OSError:
        pass
    return env


def ensure_vcpkg(env: dict[str, str]) -> Path:
    toolchain = VCPKG / "scripts" / "buildsystems" / "vcpkg.cmake"
    if toolchain.is_file():
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=VCPKG,
                              capture_output=True, text=True, env=env).stdout.strip()
        if head.startswith(VCPKG_PIN[:8]):
            return toolchain
        print(f"[gltf-exporter] vcpkg checkout is {head[:8] or 'unknown'} — re-fetching the pinned {VCPKG_PIN[:8]}...")
    print(f"[gltf-exporter] fetching vcpkg @ {VCPKG_PIN[:8]} into %LOCALAPPDATA%/wowsp/vcpkg (first run only)...")
    VCPKG.parent.mkdir(parents=True, exist_ok=True)
    if VCPKG.exists():
        shutil.rmtree(VCPKG)
    subprocess.run(["git", "init", str(VCPKG)], check=True, env=env)
    subprocess.run(["git", "-C", str(VCPKG), "remote", "add", "origin", VCPKG_GIT], check=True, env=env)
    subprocess.run(["git", "-C", str(VCPKG), "fetch", "--depth", "1", "origin", VCPKG_PIN],
                   check=True, env=env)
    subprocess.run(["git", "-C", str(VCPKG), "checkout", "FETCH_HEAD"], check=True, env=env)
    subprocess.run([str(VCPKG / "bootstrap-vcpkg.bat"), "-disableMetrics"], check=True, env=env)
    return toolchain


def main() -> int:
    if not VENDOR.is_dir():
        print(f"error: {VENDOR} missing", file=sys.stderr)
        return 1
    if shutil.which("cmake") is None:
        print("error: cmake not found on PATH", file=sys.stderr)
        return 1

    env = _git_proxy_env()
    toolchain = ensure_vcpkg(env)

    # A stale CMakeCache pins the previous toolchain path — always start
    # the configure from a clean build dir.
    shutil.rmtree(BUILD_DIR, ignore_errors=True)
    configure = [
        "cmake", "-S", str(VENDOR), "-B", str(BUILD_DIR),
        f"-DCMAKE_TOOLCHAIN_FILE={toolchain}",
        "-DBUNDLE_WOWS_DEPACK=ON", "-DBUNDLE_TINYGLTF=ON", "-DBUNDLE_ARGP=ON",
    ]
    print("[gltf-exporter] configuring...")
    subprocess.run(configure, check=True, env=env)
    print("[gltf-exporter] building (Release)...")
    subprocess.run(["cmake", "--build", str(BUILD_DIR), "--config", "Release", "--", "-m"],
                   check=True, env=env)

    TOOLS.mkdir(parents=True, exist_ok=True)
    for name in BINARIES:
        src = BUILD_DIR / "Release" / name
        if not src.is_file():
            print(f"error: {src} missing after build", file=sys.stderr)
            return 1
        shutil.copy2(src, TOOLS / name)
        print(f"[gltf-exporter] installed {name} -> {TOOLS / name}")
    print("[gltf-exporter] done — batch_bake.py picks the binaries up from target/model-tools.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
