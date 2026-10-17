#!/usr/bin/env python3
"""Optimize the baked GLB model pack in place with meshopt compression.

The bake (batch_bake.py / batch_bake_maps.py / bake_lesta_*.py) emits pure
geometry — zero textures — as UNCOMPRESSED float32 buffers: ~1.38 GB across
~4000 .glb files under packages/webui/src/res/models. Running each file
through `gltf-transform optimize --compress meshopt --simplify false`
(weld + prune + quantize + EXT_meshopt_compression) measured on the real
pack:

    maps        → ~20% of the original size
    large ships → ~28%
    small ships → ~35%
    armor glbs  → ~5%   (pure hitbox shells — quantize eats them alive)
    overall     → ~22%

Why --simplify false: the measured sizes are IDENTICAL with simplification
on, so the entire win comes from weld/prune/quantize/meshopt — and skipping
the simplifier keeps every triangle (visual fidelity, no LOD surprises on
the armor hitbox overlays). Decimation buys nothing here and risks
geometry regressions.

Rollout hazard (goes in the PR body, repeated at the end of every run):
the optimized files need an app build whose modelLoader wires
MeshoptDecoder (three's GLTFLoader cannot decode EXT_meshopt_compression
without it). Old installs keep loading ONLY while the published pack stays
uncompressed — never publish an optimized res-latest until decoder-carrying
app versions are widespread. The site already ships exactly this format
(packages/website/src/res/replay/**/*.glb, loaded by glbLoader.ts /
packages/holo/src/glbLoader.ts — the precedent this script follows).

Idempotent: a file whose JSON chunk already contains
EXT_meshopt_compression is skipped untouched, so re-running after a partial
run (or after re-baking a subset) only processes the new files.

The bake is expensive to reproduce (full game-client extraction), so
--backup <dir> copies every original that actually gets replaced into the
backup tree (relative path preserved) before the swap.

Usage:
    python scripts/model_convert/optimize_glbs.py            # optimize in place
    python scripts/model_convert/optimize_glbs.py --dry-run  # measure only
    python scripts/model_convert/optimize_glbs.py --backup D:/glb-backup
    python scripts/model_convert/optimize_glbs.py --limit 25 # smoke test
"""
from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models"
PACK_COMPAT_WARNING = (
    "[pack-compat] optimized GLBs need an app build whose modelLoader wires "
    "MeshoptDecoder — do NOT publish an optimized pack as res-latest until "
    "decoder-carrying app versions are widespread (older installs keep "
    "loading only while the pack stays uncompressed)"
)


def glb_json_chunk(path: Path) -> bytes | None:
    """The raw JSON-chunk bytes of a GLB container, or None when the file is
    not a readable GLB v2. Historical bakes padded JSON chunks with NUL
    bytes (repad_glbs.py / the loader's fixGlbPadding predate the writer
    fix), so callers must search the RAW chunk bytes — json.loads would
    choke on any padded stragglers a cached pack still holds."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(20)
            if len(head) < 20 or head[0:4] != b"glTF":
                return None
            version, _total = struct.unpack_from("<II", head, 4)
            if version != 2:
                return None
            json_len = struct.unpack_from("<I", head, 12)[0]
            return fh.read(json_len)
    except OSError:
        return None


def find_pnpm() -> str:
    # pnpm ships as a .cmd shim on Windows — subprocess needs the resolved
    # path (bare "pnpm" fails CreateProcess's extension-less lookup), the
    # same dance build_installers.py's build_webui does.
    return shutil.which("pnpm") or "pnpm"


def run_transform(pnpm: str, src: Path, dst: Path) -> tuple[bool, str]:
    """One gltf-transform invocation. Single attempt per file, no retry: the
    transform is a local CPU step with deterministic output — a failure
    means the file itself (or the install) is broken, and retrying would
    just burn the same seconds again across a 4000-file pack."""
    try:
        proc = subprocess.run(
            [pnpm, "exec", "gltf-transform", "optimize", str(src), str(dst),
             "--compress", "meshopt", "--simplify", "false"],
            cwd=REPO_ROOT,  # pnpm resolves the workspace bin from the root
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        return False, f"spawn failed: {exc}"
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        return False, f"exit {proc.returncode}: {detail[:400]}"
    return True, ""


def top_dir(path: Path, root: Path) -> str:
    """First path component under the models root ('ships', 'maps', …);
    files sitting directly in the root report '<root>'."""
    rel = path.relative_to(root)
    return rel.parts[0] if len(rel.parts) > 1 else "<root>"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--models", type=Path, default=MODELS_DIR,
                    help="models tree to process (default: this checkout's "
                    "packages/webui/src/res/models)")
    ap.add_argument("--backup", type=Path, default=None, metavar="DIR",
                    help="copy every original that gets replaced into DIR "
                    "(relative path preserved) before the swap — the bake "
                    "is expensive to reproduce, keep an escape hatch")
    ap.add_argument("--dry-run", action="store_true",
                    help="run the transform to measure the result but never "
                    "touch the original files (implies no backups)")
    ap.add_argument("--limit", type=int, default=None, metavar="N",
                    help="process only the first N non-skipped files "
                    "(smoke tests; already-optimized files never count)")
    ap.add_argument("--verbose", action="store_true",
                    help="print a line per file instead of only failures")
    args = ap.parse_args()

    root = args.models.resolve()
    if not root.is_dir():
        sys.exit(f"models tree not found: {root}")
    pnpm = find_pnpm()
    started = time.monotonic()

    files = sorted(root.rglob("*.glb"))
    if not files:
        sys.exit(f"no .glb files under {root}")

    # counters + per-top-level-dir byte tallies (before → after; 'after'
    # means the size that ends up on disk, or the measured size in --dry-run)
    counts = {"optimized": 0, "already-optimized": 0, "kept-original": 0}
    per_dir: dict[str, list[int]] = {}  # name → [files, bytes_before, bytes_after]
    failures: list[str] = []
    attempted = 0

    def tally(name: str, before: int, after: int) -> None:
        row = per_dir.setdefault(name, [0, 0, 0])
        row[0] += 1
        row[1] += before
        row[2] += after

    for path in files:
        before = path.stat().st_size
        name = top_dir(path, root)

        chunk = glb_json_chunk(path)
        if chunk is None:
            counts["kept-original"] += 1
            tally(name, before, before)
            failures.append(f"{path}: not a readable GLB v2 container")
            continue
        if b"EXT_meshopt_compression" in chunk:
            counts["already-optimized"] += 1
            tally(name, before, before)
            if args.verbose:
                print(f"[skip] {path.relative_to(root)}")
            continue

        if args.limit is not None and attempted >= args.limit:
            # Past the limit the file is neither counted nor tallied — the
            # report describes only what was actually processed.
            continue
        attempted += 1

        # Temp output in the SAME directory: os.replace stays atomic (same
        # volume) and the .glb suffix makes gltf-transform write a binary
        # container (it infers the format from the extension).
        fd, tmp_name = tempfile.mkstemp(
            dir=str(path.parent), prefix=path.stem + ".", suffix=".tmp.glb"
        )
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            ok, detail = run_transform(pnpm, path.resolve(), tmp)
            if not ok:
                counts["kept-original"] += 1
                tally(name, before, before)
                failures.append(f"{path}: {detail}")
                print(f"[fail] {path.relative_to(root)} — {detail}")
                continue
            out_bytes = tmp.read_bytes()
            if len(out_bytes) < 4 or out_bytes[0:4] != b"glTF":
                counts["kept-original"] += 1
                tally(name, before, before)
                failures.append(f"{path}: output is not a GLB container")
                continue
            after = len(out_bytes)
            if after >= before:
                # meshopt cannot lose here in practice; if it somehow does,
                # the original wins and the pack keeps loading everywhere.
                counts["kept-original"] += 1
                tally(name, before, before)
                if args.verbose:
                    print(f"[keep] {path.relative_to(root)} ({before} → {after})")
                continue
            counts["optimized"] += 1
            tally(name, before, after)
            if args.verbose or args.dry_run:
                print(f"{'[dry]' if args.dry_run else '[opt ]'} "
                      f"{path.relative_to(root)} {before:,} → {after:,} "
                      f"({after * 100 // before}%)")
            if args.dry_run:
                continue
            if args.backup:
                dest = args.backup / path.relative_to(root)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, dest)
            os.replace(tmp, path)
            tmp = None  # replaced — skip the cleanup unlink
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)

    # ── report ─────────────────────────────────────────────────────────────
    print()
    print(f"{'directory':<12} {'files':>6} {'before':>14} {'after':>14} {'ratio':>7}")
    total_files = total_before = total_after = 0
    for name in sorted(per_dir):
        n, b, a = per_dir[name]
        print(f"{name:<12} {n:>6} {b:>14,} {a:>14,} {a * 100 // b if b else 0:>6}%")
        total_files += n
        total_before += b
        total_after += a
    print(f"{'TOTAL':<12} {total_files:>6} {total_before:>14,} {total_after:>14,} "
          f"{total_after * 100 // total_before if total_before else 0:>6}%")
    print()
    print(f"optimized: {counts['optimized']}  already-optimized: "
          f"{counts['already-optimized']}  kept-original: {counts['kept-original']}")
    if args.dry_run:
        print("dry-run — no file was modified, no backup was written")
    if failures:
        print(f"\n{len(failures)} failure(s):")
        for line in failures:
            print(f"  {line}")
    print(f"\nelapsed: {time.monotonic() - started:.1f}s")
    print(PACK_COMPAT_WARNING)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
