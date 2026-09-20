#!/usr/bin/env python3
"""Publish the single content-addressed resource pack to GitHub Releases.

Game-engine style resource management, split from the app binary's own
`v*` tag channel:

  app binary → version tags (`v0.4.0` …), updated by `update.rs`
  resource pack → the FIXED `res-latest` release, versioned by a content
    tree hash + published-at timestamp carried in a small `wowsp-res.json`
    manifest asset. The tree hash is computed over the sorted per-file
    sha256 manifest of the staged tree (`models/` + `dogtags/`), so the
    same content always hashes the same regardless of upload timestamps —
    and the app's Settings → updates panel shows its last 6 hex chars.

Each full publish ALSO uploads a chain patch: the release tagged
`res-delta-<from-tree>-<to-tree>` carries a `wowsp-res-delta.tar.gz`
with the changed/added files (each pre-hashed) plus a removal list.
The newest THREE deltas are retained — a client at most three versions
behind walks the chain (`res-delta-A-B` then `res-delta-B-C`); anything
older falls back to the hash-verified full archive. Publishing the next
round deletes the fourth-oldest delta release and its tag.

Workflow:
  1. Run `just extract models && just bake-ships` to produce the GLBs.
     Run `just extract dogtags` to refresh the dog-tag map + PNGs.
     Run `just extract ship-images` for the preview portraits.
  2. Run this script: `python scripts/release_models.py`.
     `--dry-run` packages + diffs without uploading anything.
     `--images-only` refreshes just the build-time ship-portrait asset.

Everything talks to GitHub through the `gh` CLI (authenticated, `repo`
scope) so whoever holds repository access simply runs the script — no
separate token handling. The previous manifest (and nothing heavier —
old file hashes ride inside it) is fetched through the same CLI.

Output layout on the `res-latest` release:
  wowsp-res.tar.gz        full pack (top-level `models/` + `dogtags/`)
  wowsp-res.json          manifest: treeSha256, version, assetSha256,
                          assetSize, per-file sha256 map
  wowsp-images.tar.gz     build-time ship portraits (release CI embeds
                          them into the app binary; not part of the
                          runtime update channel)
Chain patches live on their own `res-delta-<from>-<to>` releases.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "models"
DOGTAGS_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "dogtags"
DOGTAGS_MAP = REPO_ROOT / "packages" / "webui" / "src" / "data" / "dogtags_map.json"
SHIP_IMAGES_DIR = REPO_ROOT / "packages" / "webui" / "src" / "res" / "images" / "ships"
REPO = "langyo/wowsp"
PRIMARY_TAG = "res-latest"
RES_ARCHIVE = "wowsp-res.tar.gz"
RES_MANIFEST = "wowsp-res.json"
IMAGES_ARCHIVE = "wowsp-images.tar.gz"
DELTA_TAG_PREFIX = "res-delta-"
DELTA_ARCHIVE = "wowsp-res-delta.tar.gz"
DELTA_MANIFEST = "delta-manifest.json"
# How many newest chain-patch releases survive a publish (older ones and
# their tags are deleted); the client walks at most this many links.
KEEP_DELTAS = 3
# Small files fetched between runs cache here (the manifest).
RELEASE_CACHE = REPO_ROOT / "target" / "res-release"


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print(f"  $ {' '.join(str(c) for c in cmd)}", flush=True)
    return subprocess.run([str(c) for c in cmd], check=True, cwd=str(REPO_ROOT), **kwargs)


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


def gh_api_json(endpoint: str, method: str = "GET", stdin: str | None = None):
    return json.loads(gh_api(endpoint, method=method, stdin=stdin))


# ── Hashing ────────────────────────────────────────────────────────────────

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def compute_tree(stage: Path) -> dict[str, str]:
    """Per-file sha256 map for the staged pack tree (`models/…` +
    `dogtags/…`, pack-relative, sorted for hash stability)."""
    files: dict[str, str] = {}
    for subdir in ("models", "dogtags"):
        root = stage / subdir
        if not root.is_dir():
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                full = Path(dirpath) / name
                rel = full.relative_to(stage).as_posix()
                files[rel] = sha256_file(full)
    return dict(sorted(files.items()))


def tree_hash(files: dict[str, str]) -> str:
    """The version hash: sha256 over `path\\0sha256\\n` lines in sorted
    order — identical content always hashes identically, whatever the
    upload timestamps say."""
    h = hashlib.sha256()
    for path, digest in sorted(files.items()):
        h.update(path.encode("utf-8"))
        h.update(b"\x00")
        h.update(digest.encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


# ── Deterministic archives ─────────────────────────────────────────────────

def add_to_tar(tar: tarfile.TarFile, arcname: str, full: Path, is_dir: bool):
    info = tarfile.TarInfo(arcname)
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mode = 0o755 if is_dir else 0o644
    if is_dir:
        # TarInfo defaults to REGTYPE — without DIRTYPE the entry lands as
        # a 0-byte FILE and extraction dies on the first child path.
        info.type = tarfile.DIRTYPE
        tar.addfile(info)
    else:
        info.size = full.stat().st_size
        with open(full, "rb") as fh:
            tar.addfile(info, fh)


def build_deterministic_tar(archive: Path, stage: Path, entries: list[str]):
    """Reproducible tar.gz over the staged top-level entries: a directory
    walks in sorted order, a plain file lands as-is. Zeroed metadata,
    gzip mtime 0. Same tree in → same bytes out, so a
    republished-but-unchanged pack keeps its asset sha256 (and clients
    keep their caches)."""
    seen_dirs: set[str] = set()

    def add_parents(rel: str):
        parts = rel.split("/")[:-1]
        for i in range(len(parts)):
            d = "/".join(parts[: i + 1])
            if d not in seen_dirs:
                seen_dirs.add(d)
                add_to_tar(tar, d, stage / d, is_dir=True)

    with open(archive, "wb") as raw:
        # filename="" keeps the gzip FNAME header empty — a named fileobj
        # would otherwise leak this build's temp path into the bytes.
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w") as tar:
                for entry in entries:
                    root = stage / entry
                    if not root.is_dir():
                        add_to_tar(tar, entry, root, is_dir=False)
                        continue
                    if entry not in seen_dirs:
                        seen_dirs.add(entry)
                        add_to_tar(tar, entry, root, is_dir=True)
                    files = []
                    for dirpath, _dirnames, filenames in os.walk(root):
                        for name in filenames:
                            full = Path(dirpath) / name
                            files.append((full, full.relative_to(stage).as_posix()))
                    for full, rel in sorted(files, key=lambda e: e[1]):
                        add_parents(rel)
                        add_to_tar(tar, rel, full, is_dir=False)
    print(f"  archive: {archive.name} = {archive.stat().st_size / 1024 / 1024:.1f} MB")


# ── Staging ────────────────────────────────────────────────────────────────

def stage_pack(tmp: str) -> Path:
    """Stage `models/` + `dogtags/` (+ the dog-tag map) into one tree —
    the exact layout the full archive packs and the installer relocates."""
    if not MODELS_DIR.is_dir():
        print(f"error: models dir not found: {MODELS_DIR}", file=sys.stderr)
        print("  Run `just extract models && just bake-ships` first.", file=sys.stderr)
        sys.exit(1)
    stage = Path(tmp) / "res-pkg"
    shutil.copytree(MODELS_DIR, stage / "models")
    if DOGTAGS_DIR.is_dir():
        shutil.copytree(DOGTAGS_DIR, stage / "dogtags")
        if DOGTAGS_MAP.is_file():
            shutil.copy2(DOGTAGS_MAP, stage / "dogtags" / DOGTAGS_MAP.name)
        else:
            print("  warning: dogtags_map.json missing — pack ships PNGs only")
    else:
        print(f"  dogtags dir not found ({DOGTAGS_DIR}) — models only")
    return stage


def package_ship_images(tmp: str) -> Path | None:
    """Stage the gitignored ship preview portraits into wowsp-images.tar.gz.

    The portraits (`images/ships/[0-9]*.png` + `_index.json`) are derived
    downloads (scripts/extract/download_ship_images.py) and gitignored, so
    release CI cannot get them from a checkout — they ride this archive
    instead, land in `src/res/images/ships/` on extraction, and the webui
    build then embeds them into the app binary via publicDir. Only the
    gitignored subset is packed: the 32 tracked portraits (named specials)
    keep coming from git, and a stale pack can never overwrite them.
    """
    if not SHIP_IMAGES_DIR.is_dir():
        print(f"  ship images dir not found ({SHIP_IMAGES_DIR}) — skip")
        return None
    stage = Path(tmp) / "images-pkg" / "images" / "ships"
    stage.mkdir(parents=True)
    packed = 0
    for entry in sorted(SHIP_IMAGES_DIR.iterdir()):
        if entry.is_file() and (
            entry.name == "_index.json" or (entry.name.endswith(".png") and entry.name[0].isdigit())
        ):
            shutil.copy2(entry, stage / entry.name)
            packed += 1
    if packed == 0:
        print("  no ship preview portraits found — skip")
        return None
    archive = Path(tmp) / IMAGES_ARCHIVE
    build_deterministic_tar(archive, stage.parent.parent, ["images"])
    print(f"  ({packed} portrait files)")
    return archive


# ── Release plumbing (all through gh) ──────────────────────────────────────

def release_exists(tag: str) -> bool:
    r = subprocess.run(
        ["gh", "release", "view", tag, "--repo", REPO],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    return r.returncode == 0


def ensure_release(tag: str, name: str, body: str):
    if release_exists(tag):
        return
    payload = json.dumps({
        "tag_name": tag,
        "name": name,
        "body": body,
        "draft": False,
        "prerelease": False,
    })
    gh_api(f"repos/{REPO}/releases", method="POST", stdin=payload)


def download_release_asset(tag: str, pattern: str, dest: Path) -> bool:
    """One release asset down through gh (auth + user proxy config apply).
    False when the tag or the asset is missing."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    r = subprocess.run(
        ["gh", "release", "download", tag, "--repo", REPO,
         "--pattern", pattern, "--output", str(dest)],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    if r.returncode != 0:
        print(f"  gh release download {tag}/{pattern} failed — {r.stderr.strip()[:200]}")
        return False
    return True


def delete_release_by_tag(tag: str) -> None:
    """Delete a GitHub Release and its Git tag, if they exist."""
    r = subprocess.run(
        ["gh", "api", f"repos/{REPO}/releases/tags/{tag}"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    if r.returncode != 0:
        print(f"  no release for tag {tag} — skip")
        return
    release = json.loads(r.stdout)
    release_id = release["id"]
    print(f"  deleting release {tag} (id={release_id}) ...")
    gh_api(f"repos/{REPO}/releases/{release_id}", method="DELETE")
    subprocess.run(
        ["gh", "api", "--method", "DELETE", f"repos/{REPO}/git/refs/tags/{tag}"],
        capture_output=True, cwd=str(REPO_ROOT),
    )


def prune_old_deltas(keep: int = KEEP_DELTAS) -> None:
    """Keep the newest `keep` res-delta-* releases; delete older ones and
    their tags. The client chain-walks at most the retained links."""
    releases = gh_api_json(f"repos/{REPO}/releases?per_page=100")
    deltas = [
        r for r in releases
        if str(r.get("tag_name", "")).startswith(DELTA_TAG_PREFIX)
    ]
    deltas.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    for stale in deltas[keep:]:
        print(f"  pruning delta beyond the newest {keep}: {stale['tag_name']}")
        delete_release_by_tag(stale["tag_name"])
    if len(deltas) <= keep:
        print(f"  {len(deltas)} delta release(s) present — within the keep-{keep} budget")


# ── Delta construction ─────────────────────────────────────────────────────

def build_delta(stage: Path, new_files: dict[str, str], old_manifest: dict,
                old_tree_hash: str, new_tree_hash: str, tmp: str) -> Path | None:
    """Diff the new tree against the previous manifest and pack the chain
    patch (`delta-manifest.json` + `files/**`). The old manifest already
    carries every old file hash, so the previous archive never has to be
    downloaded. None when nothing actually changed."""
    old_files: dict[str, str] = old_manifest.get("files", {})
    changed = [p for p, h in new_files.items() if old_files.get(p) != h]
    removed = [p for p in old_files if p not in new_files]
    if not changed and not removed:
        print("  tree identical to the published manifest — no delta needed")
        return None

    delta_dir = Path(tmp) / "delta-pkg"
    files_root = delta_dir / "files"
    for rel in changed:
        dest = files_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(stage / rel, dest)
    manifest = {
        "format": 1,
        "from": old_tree_hash,
        "to": new_tree_hash,
        "changed": [
            {"path": rel, "sha256": new_files[rel], "size": (stage / rel).stat().st_size}
            for rel in sorted(changed)
        ],
        "removed": sorted(removed),
    }
    (delta_dir / DELTA_MANIFEST).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    archive = Path(tmp) / DELTA_ARCHIVE
    build_deterministic_tar(archive, delta_dir, [DELTA_MANIFEST, "files"])
    total = sum(e["size"] for e in manifest["changed"])
    print(
        f"  delta {old_tree_hash[-6:]}→{new_tree_hash[-6:]}: "
        f"{len(changed)} changed (+{total / 1024 / 1024:.1f} MB), {len(removed)} removed"
    )
    return archive


# ── Modes ──────────────────────────────────────────────────────────────────

def images_only() -> None:
    """Refresh just the ship-portrait asset on the existing res-latest
    release (build-time input for release CI; the runtime pack is
    untouched)."""
    with tempfile.TemporaryDirectory() as tmp:
        archive = package_ship_images(tmp)
        if archive is None:
            sys.exit(1)
        run([
            "gh", "release", "upload", PRIMARY_TAG,
            str(archive),
            "--repo", REPO,
            "--clobber",
        ])
    print(f"done. ship-portrait pack refreshed on https://github.com/{REPO}/releases/tag/{PRIMARY_TAG}")


def publish(dry_run: bool) -> None:
    RELEASE_CACHE.mkdir(parents=True, exist_ok=True)

    print("[1/5] staging the pack tree ...")
    with tempfile.TemporaryDirectory() as tmp:
        stage = stage_pack(tmp)

        print("[2/5] hashing the tree ...")
        new_files = compute_tree(stage)
        new_hash = tree_hash(new_files)
        now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        print(f"  tree hash: {new_hash} (shown as {new_hash[-6:].upper()})")
        print(f"  published-at: {now}")

        # The previous manifest drives both the chain patch and the
        # identical-content short-circuit.
        old_manifest_path = RELEASE_CACHE / RES_MANIFEST
        old_manifest: dict | None = None
        if download_release_asset(PRIMARY_TAG, RES_MANIFEST, old_manifest_path):
            try:
                old_manifest = json.loads(old_manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                print(f"  previous manifest unreadable ({exc}) — treating as first publish")
        old_hash = str(old_manifest.get("treeSha256", "")) if old_manifest else ""
        if old_hash and old_hash == new_hash:
            print("published tree is identical to the staged tree — nothing to do.")
            return

        print("[3/5] packing the full archive + manifest ...")
        full_archive = Path(tmp) / RES_ARCHIVE
        build_deterministic_tar(full_archive, stage, ["models", "dogtags"])
        asset_sha = sha256_file(full_archive)
        manifest = {
            "format": 1,
            "treeSha256": new_hash,
            "version": now,
            "assetSha256": asset_sha,
            "assetSize": full_archive.stat().st_size,
            "files": new_files,
        }
        manifest_path = Path(tmp) / RES_MANIFEST
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  manifest: treeSha256=…{new_hash[-6:].upper()} assetSha256={asset_sha[:12]}…")

        print("[4/5] building the chain patch ...")
        delta_archive: Path | None = None
        delta_tag = ""
        if old_hash:
            delta_archive = build_delta(stage, new_files, old_manifest or {}, old_hash, new_hash, tmp)
            delta_tag = f"{DELTA_TAG_PREFIX}{old_hash}-{new_hash}"
            if delta_archive is not None:
                print(f"  delta release tag: {delta_tag}")

        images_archive = package_ship_images(tmp)

        if dry_run:
            print("[5/5] dry run — skipping all uploads and pruning.")
            print("done (dry run).")
            return

        print("[5/5] uploading ...")
        if delta_archive is not None:
            ensure_release(
                delta_tag,
                f"Resource Pack delta …{old_hash[-6:].upper()}→…{new_hash[-6:].upper()}",
                "Chain patch for the content-addressed resource pack. "
                "Applied automatically by the app when the local tree hash "
                "matches `from`; otherwise ignored.",
            )
            run([
                "gh", "release", "upload", delta_tag,
                str(delta_archive),
                "--repo", REPO,
                "--clobber",
            ])

        ensure_release(
            PRIMARY_TAG,
            "Resource Pack (latest)",
            "Baked ship & map GLB models + dog-tag art, versioned by content "
            "tree hash. Automatically downloaded / chain-patched by the app.",
        )
        uploads = [str(full_archive), str(manifest_path)]
        if images_archive is not None:
            uploads.append(str(images_archive))
        run(["gh", "release", "upload", PRIMARY_TAG, *uploads, "--repo", REPO, "--clobber"])

        prune_old_deltas()

    print("done.")
    print(f"  App updates from: https://github.com/{REPO}/releases/tag/{PRIMARY_TAG}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="stage, hash, pack and diff without uploading or pruning",
    )
    ap.add_argument(
        "--images-only",
        action="store_true",
        help="re-upload only wowsp-images.tar.gz (ship preview portraits) "
             "onto the existing res-latest release (runtime pack untouched)",
    )
    args = ap.parse_args()
    if args.images_only:
        images_only()
        return
    publish(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
