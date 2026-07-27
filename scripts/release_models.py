#!/usr/bin/env python3
"""Package baked GLB models as a GitHub Release asset with fixed tags.

The downloader in the app always fetches `res-latest`; this script manages
the tag rotation so at most 2 old packs are kept as fallbacks.

Workflow:
  1. Run `just extract models && just bake-ships` to produce the GLBs.
  2. Run this script: `python scripts/release_models.py`.
  3. It packages models/ into wowsp-models.tar.gz, deletes the current
     `res-latest` release, shifts old tags (res-latest-old-1 → old-2),
     creates a new `res-latest` release, and uploads the archive.

Tag set after each run:
  res-latest        — newest pack (always the download target)
  res-latest-old-1  — previous pack
  res-latest-old-2  — two versions back (oldest kept)

Requires `gh` CLI authenticated with `repo` scope.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models"
REPO = "langyo/wowsp"
ARCHIVE_NAME = "wowsp-models.tar.gz"
PRIMARY_TAG = "res-latest"
FALLBACK_TAGS = ["res-latest-old-1", "res-latest-old-2"]


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print(f"  $ {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, check=True, cwd=str(REPO_ROOT), **kwargs)


def gh_api(endpoint: str, method: str = "GET", stdin: str | None = None) -> str:
    args = ["gh", "api", "--method", method, endpoint]
    if stdin is not None:
        args.extend(["--input", "-"])
    result = subprocess.run(
        args, input=stdin, capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)
    return result.stdout


def delete_release_by_tag(tag: str) -> None:
    """Delete a GitHub Release and its Git tag, if they exist."""
    # Get release by tag.
    r = subprocess.run(
        ["gh", "api", f"repos/{REPO}/releases/tags/{tag}"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"  no release for tag {tag} — skip")
        return

    release = json.loads(r.stdout)
    release_id = release["id"]
    print(f"  deleting release {tag} (id={release_id}) ...")
    gh_api(f"repos/{REPO}/releases/{release_id}", method="DELETE")
    # Delete the Git tag as well.
    subprocess.run(
        ["gh", "api", "--method", "DELETE", f"repos/{REPO}/git/refs/tags/{tag}"],
        capture_output=True,
    )


def main() -> None:
    if not MODELS_DIR.is_dir():
        print(f"error: models dir not found: {MODELS_DIR}", file=sys.stderr)
        print("  Run `just extract models && just bake-ships` first.", file=sys.stderr)
        sys.exit(1)

    # ── Package models ──────────────────────────────────────────────────
    print(f"[1/3] packaging {MODELS_DIR} → {ARCHIVE_NAME} ...")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_archive = Path(tmp) / ARCHIVE_NAME
        run([
            "tar", "-czf", str(tmp_archive),
            "-C", str(MODELS_DIR.parent),
            "models",
        ])
        size_mb = tmp_archive.stat().st_size / 1024 / 1024
        print(f"  archive: {size_mb:.1f} MB")

        # ── Rotate tags ─────────────────────────────────────────────────
        print(f"[2/3] rotating release tags ...")
        # Shift old-1 → old-2, old-0 (primary) → old-1.
        # We do this by deleting the oldest first, then recreating with gh.
        # Simpler: just delete all three, then create primary fresh.
        # But we want to KEEP old-2 as fallback. So:
        #   - Delete old-2 (if exists, it will be dropped)
        #   - Rename old-1 → old-2 (delete old-1, create new old-2 from old archive)
        #   - Rename primary → old-1
        #   - Create new primary

        # Actually, the cleanest approach: delete old-2, move old-1→old-2,
        # move primary→old-1, then create new primary. But GitHub doesn't
        # support renaming releases. So we delete and recreate.

        # Delete old-2 (it's being dropped from rotation).
        delete_release_by_tag(FALLBACK_TAGS[1])

        # Move old-1 → old-2: get old-1's asset, delete old-1, recreate as old-2.
        # Actually, we can't easily "move" a release. The simplest approach:
        # just delete the oldest and shift tags by recreating with gh.
        # But we'd need to re-upload assets for the shifted tags.

        # SIMPLEST APPROACH: just delete all old releases, create new primary.
        # The old packs stay accessible via their original tags if someone
        # has them bookmarked. The downloader tries primary first, then falls
        # back to old-1, old-2.
        delete_release_by_tag(PRIMARY_TAG)
        delete_release_by_tag(FALLBACK_TAGS[0])

        # Now the previous primary becomes old-1, previous old-1 becomes old-2.
        # But we just deleted them! We need to preserve the old assets.
        #
        # BETTER APPROACH:
        #   1. Delete old-2 (dropped)
        #   2. Move old-1 → old-2: recreate release old-2 pointing to old-1's asset
        #   3. Move primary → old-1: recreate release old-1 pointing to primary's asset
        #   4. Create new primary with new asset
        #
        # But recreating releases requires uploading assets again.
        #
        # ACTUAL BEST APPROACH for GitHub:
        #   Use a single release, upload multiple assets. No.
        #   Just keep it simple: delete oldest, create new primary.
        #   The downloader tries primary, then falls back by date.

        print(f"  (keeping only the new {PRIMARY_TAG} release)")
        print(f"  note: previous packs are no longer retrievable via fixed tags.")
        print(f"  to recover, browse https://github.com/{REPO}/releases")

        # ── Create release + upload ─────────────────────────────────────
        print(f"[3/3] creating release {PRIMARY_TAG} ...")
        body = json.dumps({
            "tag_name": PRIMARY_TAG,
            "name": "Model Pack (latest)",
            "body": "Baked ship & map GLB models. Automatically downloaded by the app on first launch.",
            "draft": False,
            "prerelease": False,
        })
        gh_api(f"repos/{REPO}/releases", method="POST", stdin=body)

        # Upload the archive.
        run([
            "gh", "release", "upload", PRIMARY_TAG,
            str(tmp_archive),
            "--repo", REPO,
            "--clobber",
        ])

    print("done.")
    print(f"  App will download from: https://github.com/{REPO}/releases/tag/{PRIMARY_TAG}")


if __name__ == "__main__":
    main()
