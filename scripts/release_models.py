#!/usr/bin/env python3
"""Package baked GLB models as a GitHub Release asset and prune old releases.

Workflow:
  1. Run `just extract models` and `just bake-ships` to produce the GLBs under
     `packages/webui/src/res/models/`.
  2. Run this script: `python scripts/release_models.py <version>`.
  3. It packages models/ into a tar.gz, creates a GitHub Release tagged
     `models-v<version>`, uploads the archive, then deletes the oldest releases
     so only the 3 most recent remain.

Requires `gh` CLI authenticated with `repo` scope.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models"
REPO = "langyo/wowsp"
TAG_PREFIX = "models-v"
KEEP = 3


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print(f"  $ {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, check=True, cwd=str(REPO_ROOT), **kwargs)


def gh_api(endpoint: str, method: str = "GET", stdin: str | None = None) -> str:
    """Call `gh api` and return stdout."""
    args = ["gh", "api", "--method", method, endpoint]
    if stdin is not None:
        args.extend(["--input", "-"])
    result = subprocess.run(
        args,
        input=stdin,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)
    return result.stdout


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("version", help="model-pack version (e.g. 0.14.1)")
    ap.add_argument("--repo", default=REPO, help=f"GitHub owner/repo (default: {REPO})")
    ap.add_argument("--keep", type=int, default=KEEP, help=f"keep N most recent releases (default: {KEEP})")
    ap.add_argument("--dry-run", action="store_true", help="print actions without executing")
    args = ap.parse_args()

    tag = f"{TAG_PREFIX}{args.version}"
    archive_name = f"wowsp-models-{args.version}.tar.gz"

    if not MODELS_DIR.is_dir():
        print(f"error: models dir not found: {MODELS_DIR}", file=sys.stderr)
        print("  Run `just extract models && just bake-ships` first.", file=sys.stderr)
        sys.exit(1)

    # ── Package models ──────────────────────────────────────────────────
    print(f"[1/4] packaging {MODELS_DIR} → {archive_name} ...")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_archive = Path(tmp) / archive_name
        # Create a tar.gz with flat content (models/ is at the root of the archive).
        run(
            [
                "tar", "-czf", str(tmp_archive),
                "-C", str(MODELS_DIR.parent),
                "models",
            ],
            # tar on Windows (Git Bash) may need explicit exe path.
        )
        archive_size = tmp_archive.stat().st_size
        print(f"  archive: {archive_size / 1024 / 1024:.1f} MB")

        # ── Create GitHub Release ───────────────────────────────────────
        print(f"[2/4] creating GitHub Release {tag} ...")
        if args.dry_run:
            print(f"  [dry-run] would create release {tag} and upload {archive_name}")
        else:
            body = json.dumps({
                "tag_name": tag,
                "name": f"Models {args.version}",
                "body": f"Baked ship & map GLB models for game version {args.version}.",
                "draft": False,
                "prerelease": False,
            })
            gh_api(f"repos/{args.repo}/releases", method="POST", stdin=body)

            # Upload the archive asset.
            # First get the release ID.
            release_json = gh_api(f"repos/{args.repo}/releases/tags/{tag}")
            release = json.loads(release_json)
            release_id = release["id"]

            print(f"[3/4] uploading {archive_name} to release {release_id} ...")
            run([
                "gh", "release", "upload", tag,
                str(tmp_archive),
                "--repo", args.repo,
                "--clobber",
            ])

    # ── Prune old releases ──────────────────────────────────────────────
    print(f"[4/4] pruning old model releases (keeping {args.keep}) ...")
    releases_raw = gh_api(f"repos/{args.repo}/releases?per_page=100")
    releases = json.loads(releases_raw)
    model_releases = [
        r for r in releases
        if isinstance(r.get("tag_name"), str) and r["tag_name"].startswith(TAG_PREFIX)
    ]
    # Sort by created_at descending (newest first).
    model_releases.sort(key=lambda r: r["created_at"], reverse=True)

    if len(model_releases) <= args.keep:
        print(f"  {len(model_releases)} model release(s) — nothing to prune.")
        return

    to_delete = model_releases[args.keep:]
    for r in to_delete:
        tag_name = r["tag_name"]
        if args.dry_run:
            print(f"  [dry-run] would delete release {tag_name}")
        else:
            print(f"  deleting release {tag_name} ...")
            gh_api(f"repos/{args.repo}/releases/{r['id']}", method="DELETE")
            # Also delete the tag.
            run(["gh", "api", "--method", "DELETE", f"repos/{args.repo}/git/refs/tags/{tag_name}"])

    print("done.")


if __name__ == "__main__":
    main()
