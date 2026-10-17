"""Convert the webui's res PNG classes to WebP in place.

The webui's publicDir (packages/webui/src/res) rides into every build, and
the PNG classes below dominate its size. WebP cuts them roughly in half
(measured on Pillow method=6):

    class               files  setting        measured ratio
    silhouettes         1308   LOSSLESS       46% (smaller than q85 AND
                                              exact plaque edges)
    minimaps              54   q85 lossy      17%
    dogtags              638   q85 lossy      31%
    ribbons              72    q85 lossy      35%
    tech-tree-features   147   q85 lossy      ~35%
    stamps               12    q85 lossy      (tiny)
    planes                7    q85 lossy      (tiny)
    hud icons            32    q85 lossy      (tiny)
    portraits          1190    q85 lossy      44% (gitignored CDN downloads)

Encoder options mirror the existing png_to_webp() precedent in
extract_game_assets.py / build_planner_data.py: lossy = quality 85 method 6,
lossless = quality 90 method 6.

The consumers (shipImages.ts, modelLoader.ts, PlayerBadge.tsx,
techTreeData.ts) are extension-resilient — they glob `*.{png,webp}` or
retry `.png` on error — so a tree mid-conversion (old resource packs still
holding .png) keeps rendering. This script is both the one-shot that
flipped the tracked files in git and the maintainer's re-encoder for the
gitignored portrait downloads on a local tree:

    python scripts/extract/convert_res_webp.py --all
    python scripts/extract/convert_res_webp.py portraits
    python scripts/extract/convert_res_webp.py --all --dry-run

Each .png is deleted only after the written .webp re-opens and matches the
source's dimensions; a failed encode leaves the .png untouched. Existing
.webp siblings are skipped (their stale .png is reported, not deleted).
"""
from __future__ import annotations

import argparse
import io
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RES_ROOT = REPO_ROOT / "packages" / "webui" / "src" / "res"


@dataclass(frozen=True)
class ClassSpec:
    rel_dir: str
    lossless: bool
    recursive: bool = False
    digit_only: bool = False  # portraits: only [0-9]*.png, never icon_*.png
    pattern: str = "*.png"


CLASSES: dict[str, ClassSpec] = {
    "silhouettes": ClassSpec("models/silhouettes", lossless=True),
    "minimaps": ClassSpec("models/maps/minimaps", lossless=False),
    "dogtags": ClassSpec("dogtags", lossless=False, recursive=True),
    "ribbons": ClassSpec("images/ribbons", lossless=False),
    "tech-tree-features": ClassSpec("images/tech-tree-features", lossless=False),
    "stamps": ClassSpec("stamps", lossless=False),
    "planes": ClassSpec("images/planes", lossless=False),
    # Battle-HUD ship icons share images/ships with the portraits; the
    # icon_*.png pattern keeps the two classes disjoint (digit-only portraits
    # are the other half).
    "hud-icons": ClassSpec("images/ships", lossless=False, pattern="icon_*.png"),
    # Gitignored CDN portrait downloads (see download_ship_images.py).
    "portraits": ClassSpec("images/ships", lossless=False, digit_only=True),
}


def png_bytes_to_webp(data: bytes, lossless: bool) -> bytes:
    """Decode image bytes (PNG etc.) and re-encode as WebP — the shared
    encoder the producer scripts (download_ship_images.py, build_dogtags.py,
    build_branch_features.py) import so every bake emits identical bytes."""
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    buf = io.BytesIO()
    if lossless:
        # Exact-edge lossless (silhouette plaques) — the q85 lossy
        # encode is no smaller there and fuzzes the thin outlines.
        img.save(buf, format="WEBP", lossless=True, quality=90, method=6)
    else:
        img.save(buf, format="WEBP", quality=85, method=6)
    return buf.getvalue()


def encode_webp(png_path: Path, lossless: bool) -> tuple[bytes, tuple[int, int]]:
    """Encode one on-disk PNG to WebP bytes; returns (bytes, source dims)."""
    from PIL import Image

    with Image.open(png_path) as img:
        dims = img.size
    return png_bytes_to_webp(png_path.read_bytes(), lossless), dims


def verify_webp(path: Path, dims: tuple[int, int]) -> bool:
    """Re-open a written WebP and sanity-check it against the source."""
    from PIL import Image

    try:
        with Image.open(path) as img:
            img.load()
            return img.size == dims
    except Exception:
        return False


def convert_class(name: str, spec: ClassSpec, dry_run: bool) -> int:
    """Convert every .png of one class in place; returns 1 on any failure."""
    root = RES_ROOT / spec.rel_dir
    if not root.is_dir():
        print(f"[res-webp] {name}: dir not found ({root}) — skipped")
        return 0

    pngs = sorted(p for p in (root.rglob(spec.pattern) if spec.recursive
                              else root.glob(spec.pattern))
                  if not spec.digit_only or p.name[:1].isdigit())
    before = after = 0
    converted = existed = failed = 0
    for png in pngs:
        webp = png.with_suffix(".webp")
        if webp.exists():
            # Already converted on an earlier run — report the stale .png
            # but never delete anything the caller did not ask to re-encode.
            existed += 1
            continue
        try:
            src_size = png.stat().st_size
            blob, dims = encode_webp(png, spec.lossless)
            if not dry_run:
                webp.write_bytes(blob)
                if not verify_webp(webp, dims):
                    webp.unlink(missing_ok=True)
                    raise ValueError("verify failed (size mismatch / undecodable)")
                png.unlink()
        except Exception as exc:  # noqa: BLE001 — one bad file must not stop the run
            failed += 1
            print(f"[res-webp]   ✗ {png.name}: {exc}", file=sys.stderr)
            if failed <= 5:
                continue
            print(f"[res-webp] {name}: too many failures, aborting class", file=sys.stderr)
            return 1
        before += src_size
        after += len(blob)
        converted += 1

    tag = " (dry run)" if dry_run else ""
    pct = f"{after / before:.0%}" if before else "—"
    mb = lambda n: f"{n / 1024 / 1024:.2f} MB"  # noqa: E731
    print(f"[res-webp] {name}: {converted} converted{tag}, "
          f"{before / max(after, 1):.2f}x → {pct} ({mb(before)} → {mb(after)})"
          + (f", {existed} already webp" if existed else "")
          + (f", {failed} FAILED" if failed else ""))
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert res PNG classes to WebP in place")
    ap.add_argument("classes", nargs="*", choices=[*CLASSES, "all"],
                    help="class(es) to convert (default: the tracked set)")
    ap.add_argument("--all", action="store_true",
                    help="every class, including the gitignored portraits")
    ap.add_argument("--dry-run", action="store_true",
                    help="measure the savings without writing anything")
    args = ap.parse_args()

    if args.all:
        selected = list(CLASSES)
    elif args.classes:
        selected = [c for c in args.classes if c != "all"] or list(CLASSES)
    else:
        # The default run converts the git-TRACKED classes only; portraits
        # (gitignored downloads, absent in CI checkouts) need --all or an
        # explicit "portraits".
        selected = [c for c in CLASSES if c != "portraits"]

    failed = 0
    for name in selected:
        failed |= convert_class(name, CLASSES[name], args.dry_run)
    return failed


if __name__ == "__main__":
    sys.exit(main())
