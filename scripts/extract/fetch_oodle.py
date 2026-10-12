#!/usr/bin/env python3
"""Ensure an Oodle decoder (unoodle) is available, building it on demand.

The Lesta (Мир кораблей) client's pkgs are Oodle-compressed, which the
vendored wowsunpack cannot read; the extraction routes shell out to a
decoder CLI instead (see lesta_extract.py). The good one is the `unoodle`
binary of github.com/lvlvllvlvllvlvl/oozextract (MIT, Rust port of ooz) —
powzix/ooz silently mis-decodes the 26.x streams, so it is fallback-only.

This helper closes the loop the manual setup used to leave open (build
unoodle by hand, drop it in target/release/, lose it to the next clean):

  1. probe the known locations — explicit path / WOWSP_OOZ / WOWSP_UNOODLE,
     repo target/, PATH, the cargo bin dir;
  2. find nothing → shallow-clone (`--depth 1`) oozextract into the shared
     extract cache (`%LOCALAPPDATA%/WoWSP-extract/oozextract` — outside
     this repo's cargo workspace, which cargo would otherwise refuse to
     build under) and `cargo build --release --features cli`, then copy
     the unoodle binary to `target/release/` where the discovery chain
     looks first;
  3. every Lesta extraction goes through lesta_extract.py, so all the bake
     routes (bake_lesta_{ships,armor,planes}.py) bootstrap automatically.
     Opt out per-run with `--no-fetch-decoder` or WOWSP_OODLE_NO_BUILD=1.

The upstream repo can be redirected with WOWSP_OODLE_REPO (e.g. a mirror).

Usage:
    python scripts/extract/fetch_oodle.py            # provision, print path
    python scripts/extract/fetch_oodle.py --ooz X    # probe a specific binary
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# The clone must live OUTSIDE this repo: cargo resolves workspaces by
# walking up from the manifest, and a clone under target/ would be adopted
# by (and rejected from) the wowsp workspace. The shared extract cache —
# where the GameParams dumps already live — is the repo's established
# cross-checkout scratch space.
CACHE_DIR = Path(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~/.local/share"))
) / "WoWSP-extract"
SOURCE_DIR = CACHE_DIR / "oozextract"
UPSTREAM_REPO = os.environ.get(
    "WOWSP_OODLE_REPO", "https://github.com/lvlvllvlvllvlvl/oozextract"
)

# (relative name, mode) pairs probed in order; the mode decides the CLI shape
# lesta_extract.py drives (unoodle: `unoodle src -o dst`, ooz: `ooz -f src dst`).
CANDIDATES = [
    "unoodle.exe",
    "unoodle",
    "ooz.exe",
    "ooz",
]


def _mode_for(path: Path) -> str:
    return "unoodle" if "unoodle" in path.name.lower() else "ooz"


def find_decoder(explicit: str | None = None) -> tuple[Path, str] | None:
    """Locate a usable decoder: explicit → env → repo target/ → PATH → cargo bin."""
    ooz_env = explicit or os.environ.get("WOWSP_OOZ") or os.environ.get("WOWSP_UNOODLE")
    if ooz_env:
        p = Path(ooz_env)
        if p.is_file():
            return p, _mode_for(p)
    search_dirs = [
        ROOT / "target" / "model-tools",
        ROOT / "target" / "release",
    ]
    cargo_bin = Path(
        os.environ.get("CARGO_HOME", Path.home() / ".cargo")
    ) / "bin"
    if cargo_bin.is_dir():
        search_dirs.append(cargo_bin)
    for directory in search_dirs:
        for name in CANDIDATES:
            p = directory / name
            if p.is_file():
                return p, _mode_for(p)
    for name in CANDIDATES[:2]:  # PATH lookup; unoodle only — an `ooz` on PATH
        found = shutil.which(name)  # is somebody else's business
        if found:
            return Path(found), _mode_for(Path(found))
    return None


def _clone_source() -> Path:
    """Shallow-clone (--depth 1) the oozextract source, reusing a previous
    clone when present (a leftover half-clone — .git without Cargo.toml —
    is wiped and re-fetched). One retry on transport failure (the proxy on
    this repo's dev machines occasionally drops the TLS read)."""
    if (SOURCE_DIR / ".git").is_dir() and (SOURCE_DIR / "Cargo.toml").is_file():
        print(f"[oodle-fetch] source already cloned: {SOURCE_DIR}")
        return SOURCE_DIR
    if (SOURCE_DIR / ".git").is_dir():
        print(f"[oodle-fetch] removing incomplete clone: {SOURCE_DIR}")
        shutil.rmtree(SOURCE_DIR, ignore_errors=True)
    if shutil.which("git") is None:
        raise SystemExit("git not found — needed to fetch the oozextract source")
    SOURCE_DIR.parent.mkdir(parents=True, exist_ok=True)
    last_err: Exception | None = None
    for attempt in (1, 2):
        print(f"[oodle-fetch] cloning {UPSTREAM_REPO} (depth=1, attempt {attempt}) ...")
        r = subprocess.run(
            ["git", "clone", "--depth", "1", UPSTREAM_REPO, str(SOURCE_DIR)],
            capture_output=True, text=True,
        )
        if r.returncode == 0 and (SOURCE_DIR / "Cargo.toml").is_file():
            return SOURCE_DIR
        last_err = RuntimeError((r.stderr or r.stdout or "clone failed").strip()[-300:])
        shutil.rmtree(SOURCE_DIR, ignore_errors=True)
    raise SystemExit(f"[oodle-fetch] clone failed: {last_err}")


def build_decoder() -> tuple[Path, str]:
    """Build unoodle from a depth-1 clone and install it into the repo's
    target/release/ (first slot of the discovery chain)."""
    if shutil.which("cargo") is None:
        raise SystemExit(
            "cargo not found — needed to build the Oodle decoder. Install a "
            "Rust toolchain, or place a prebuilt unoodle on PATH / at "
            "target/release/unoodle.exe, or pass --ooz."
        )
    _clone_source()
    print("[oodle-fetch] cargo build --release --features cli ...")
    # Pin the output dir inside the clone: an inherited CARGO_TARGET_DIR
    # (worktree builds set one) would land the binary where `built` below
    # does not look.
    env = {**os.environ, "CARGO_TARGET_DIR": str(SOURCE_DIR / "target")}
    r = subprocess.run(
        ["cargo", "build", "--release", "--features", "cli"],
        cwd=SOURCE_DIR, capture_output=True, text=True, env=env,
    )
    if r.returncode != 0:
        raise SystemExit(
            "[oodle-fetch] cargo build failed:\n"
            + (r.stderr or r.stdout or "")[-1500:]
        )
    built = SOURCE_DIR / "target" / "release" / (
        "unoodle.exe" if os.name == "nt" else "unoodle"
    )
    if not built.is_file():
        raise SystemExit(f"[oodle-fetch] build finished but {built} is missing")
    out_dir = ROOT / "target" / "release"
    out_dir.mkdir(parents=True, exist_ok=True)
    installed = out_dir / built.name
    shutil.copy2(built, installed)
    print(f"[oodle-fetch] installed decoder -> {installed}")
    return installed, _mode_for(installed)


def ensure_decoder(explicit: str | None = None, auto_build: bool = True) -> tuple[Path, str]:
    """Find a decoder, or (when allowed) fetch + build one. Raises SystemExit
    with manual instructions when neither works."""
    found = find_decoder(explicit)
    if found:
        return found
    if not auto_build or os.environ.get("WOWSP_OODLE_NO_BUILD", "0") not in ("", "0"):
        raise SystemExit(
            "no Oodle decoder found — run `python scripts/extract/fetch_oodle.py` "
            "(or `just build unoodle`), build github.com/lvlvllvlvllvlvl/oozextract "
            "by hand (cargo build --release --features cli), or pass --ooz / set "
            "WOWSP_OOZ"
        )
    print("[oodle-fetch] no Oodle decoder found — fetching one ...")
    return build_decoder()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ooz", help="probe this decoder binary instead of auto-discovery")
    ap.add_argument(
        "--no-build", action="store_true",
        help="report/locate only — never clone or build",
    )
    ap.add_argument(
        "--build", action="store_true",
        help="always clone + build + install into target/release/, even when a "
        "decoder is already discoverable (e.g. replacing a broken build — the "
        "crates.io 0.5.5 unoodle exits 0 without output on the 26.x streams)",
    )
    args = ap.parse_args()
    if args.build:
        path, mode = build_decoder()
    else:
        path, mode = ensure_decoder(args.ooz, auto_build=not args.no_build)
    print(f"[oodle-fetch] {mode}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
