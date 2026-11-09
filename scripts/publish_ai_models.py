#!/usr/bin/env python3
"""Publish the built-in decision models to the Hugging Face model repository.

The design contract is docs/en/designs/ai-models.md. The app consumes:

  - manifest.json: the signed runtime manifest (Ed25519, the same pinned
    keys as the release-digest channel). It pins every runtime file by
    sha256 and the Hugging Face commit that contains exactly those bytes.
  - onnx/*.onnx and attrs/ship_attributes.json (plus an optional
    los/<mapId>/terrain_los.npz tree): the runtime payload. Every file
    stays below 10 MB so updates stay small; the Hub stores binaries
    through Xet/LFS and /resolve/ answers a signed CDN redirect, which the
    downloader follows (Range/resume on the final host, no Xet client).

Workflow (two commits, so the manifest can pin the artifact commit):

  1. stage the artifacts, upload them -> commit A;
  2. write manifest.json with "revision": A, sign it, upload the manifest
     and the model card -> commit B.

Usage:

    python scripts/publish_ai_models.py --dry-run     # stage + sign, no upload
    python scripts/publish_ai_models.py               # publish to the Hub

Credentials come from the huggingface_hub token store (hf auth login) or
the HF_TOKEN environment variable. The signing seed comes from
~/.wowsp-signing/digest-main.key, WOWSP_DIGEST_SIGNING_KEY (base64 seed),
or --signing-key. Never put the seed in the repository.
"""

from __future__ import annotations

import argparse
import base64
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

# Sibling module (same directory: sys.path[0] when run as a script).
import catalog_signing

REPO_ROOT = Path(__file__).resolve().parent.parent
REPO = "langyo/wowsp"
DEFAULT_HF_REPO = "langyo/wowsp-d1"
MANIFEST_NAME = "manifest.json"
KEY_ID = "main"
MAX_FILE_BYTES = 10 * 1024 * 1024
TRAINING_PATHS = ("scripts/experiments",)

# The deployed models. src is relative to --out-dir (the experiments output
# tree); dest is the flat file name inside <cache>/decisions on the client.
MODELS = (
    {
        "dest": "fire_model.onnx",
        "src": "fire_model/v2plain_std/fp32.onnx",
        "kind": "fire-two-head",
        "feature_set": "fire-v1",
        "quant": "fp32",
        "required": True,
    },
    {
        "dest": "move_model.onnx",
        "src": "move_model/node3/main/fp32.onnx",
        "kind": "move-sectors-17",
        "feature_set": "move-v1",
        "quant": "fp32",
        "required": True,
    },
    {
        "dest": "advice_fire_model.onnx",
        "src": "fire_model/e24_attrs/fp32.onnx",
        "kind": "advice-fire-attrs",
        "feature_set": "advice-e24",
        "quant": "fp32",
        "required": False,
    },
    {
        "dest": "torpedo_model.onnx",
        "src": "torpedo_model/final/fp32.onnx",
        "kind": "torpedo-three-head",
        "feature_set": "torpedo-e26d",
        "quant": "fp32",
        "required": False,
    },
)

ATTRS_SRC = REPO_ROOT / "scripts" / "experiments" / "ship_attributes.json"
ATTRS_DEST = "ship_attributes.json"
ATTRS_REPO_PATH = "attrs/ship_attributes.json"


def die(message: str) -> "SystemExit":
    return SystemExit(f"error: {message}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_hash(file_hashes: dict[str, str]) -> str:
    """Content identity: sha256 over the sorted path-NUL-sha lines (the
    same provider-neutral formula the resource pack uses)."""
    lines = "".join(f"{path}\0{sha}\n" for path, sha in sorted(file_hashes.items()))
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


def git_head() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def copy_checked(src: Path, dest: Path, label: str) -> dict:
    if not src.is_file():
        raise die(f"{label} is missing: {src}")
    size = src.stat().st_size
    if size <= 0:
        raise die(f"{label} is empty: {src}")
    if size >= MAX_FILE_BYTES:
        raise die(
            f"{label} is {size} bytes: keep every published file below "
            f"{MAX_FILE_BYTES} bytes so the Hub serves it as a plain Git blob"
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return {"path": dest.name, "sha256": sha256_file(dest), "size": size}


def stage_artifacts(stage: Path, out_dir: Path) -> tuple[list[dict], dict[str, str]]:
    """Copy the runtime payload into the upload tree and return the
    manifest file entries plus the full repo-relative path -> sha map."""
    entries: list[dict] = []
    repo_hashes: dict[str, str] = {}

    for spec in MODELS:
        src = out_dir / spec["src"]
        dest = stage / "onnx" / spec["dest"]
        entry = copy_checked(src, dest, spec["dest"])
        entry["kind"] = spec["kind"]
        entry["featureSet"] = spec["feature_set"]
        entry["quant"] = spec["quant"]
        entries.append(entry)
        repo_hashes[f"onnx/{spec['dest']}"] = entry["sha256"]

    attrs = copy_checked(ATTRS_SRC, stage / ATTRS_REPO_PATH, "ship_attributes.json")
    entries.append(attrs)
    repo_hashes[ATTRS_REPO_PATH] = attrs["sha256"]

    return entries, repo_hashes


def stage_los(stage: Path, los_dir: Path) -> tuple[list[dict], dict[str, str]]:
    """Optional LOS raster tree: one terrain_los.npz per map directory."""
    if not los_dir.is_dir():
        raise die(f"--los-dir is not a directory: {los_dir}")
    entries: list[dict] = []
    repo_hashes: dict[str, str] = {}
    for raster in sorted(los_dir.glob("*/terrain_los.npz")):
        map_id = raster.parent.name
        if not map_id or "/" in map_id or "\\" in map_id or map_id.startswith("."):
            raise die(f"unusable map directory name: {map_id!r}")
        dest = stage / "los" / map_id / "terrain_los.npz"
        entry = copy_checked(raster, dest, f"LOS raster {map_id}")
        entry["path"] = f"{map_id}/terrain_los.npz"
        entries.append(entry)
        repo_hashes[f"los/{map_id}/terrain_los.npz"] = entry["sha256"]
    if not entries:
        raise die(f"no */terrain_los.npz found under {los_dir}")
    return entries, repo_hashes


def stage_training(stage: Path) -> None:
    """Snapshot the tracked experiments scripts (training/deployment code).

    Generated output under scripts/experiments/out is gitignored and is not
    part of the snapshot; the model card states the GitHub commit is the
    authoritative source.
    """
    training = stage / "training"
    training.mkdir(parents=True, exist_ok=True)
    archive = subprocess.run(
        ["git", "archive", "--format=tar", "HEAD", *TRAINING_PATHS],
        cwd=str(REPO_ROOT),
        capture_output=True,
        check=True,
    )
    tar_path = training / "scripts.tar"
    tar_path.write_bytes(archive.stdout)
    with tarfile.open(tar_path) as tar:
        for member in tar.getmembers():
            if member.isfile():
                relative = member.name.split("scripts/experiments/", 1)[-1]
                if not relative or relative.startswith("/") or ".." in relative.split("/"):
                    continue
                target = training / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                extracted = tar.extractfile(member)
                if extracted is None:
                    continue
                target.write_bytes(extracted.read())
    tar_path.unlink()


def read_los_tree_hash(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"warning: cannot read --res-tree-stamp {path}: {exc}", file=sys.stderr)
        return None
    value = data.get("treeSha256")
    return value if isinstance(value, str) and len(value) == 64 else None


def load_signing_seed(args: argparse.Namespace) -> bytes:
    env_seed = os.environ.get("WOWSP_DIGEST_SIGNING_KEY", "").strip()
    if env_seed:
        seed = base64.b64decode(env_seed, validate=True)
        if len(seed) != 32:
            raise die("WOWSP_DIGEST_SIGNING_KEY is not a 32-byte base64 seed")
        return seed
    key_path = Path(args.signing_key).expanduser()
    if not key_path.is_file():
        raise die(
            f"signing key not found: {key_path} (or export "
            "WOWSP_DIGEST_SIGNING_KEY with the base64 seed)"
        )
    return catalog_signing.load_private_seed(key_path)


def fetch_previous_seq(repo_id: str) -> int:
    """The currently published manifest's seq (0 when the repo is fresh)."""
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as exc:  # pragma: no cover - environment guard
        raise die("huggingface_hub is required for publishing: pip install huggingface_hub") from exc
    try:
        path = hf_hub_download(
            repo_id=repo_id,
            filename=MANIFEST_NAME,
            repo_type="model",
            token=os.environ.get("HF_TOKEN") or None,
        )
    except Exception:  # noqa: BLE001 - a missing manifest on a fresh repo
        return 0
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    seq = doc.get("seq")
    return seq if isinstance(seq, int) and seq > 0 else 0


def build_manifest(
    entries: list[dict],
    *,
    seq: int,
    revision: str,
    version: str,
    source_commit: str,
    res_tree_sha256: str | None,
) -> dict:
    file_hashes = {entry["path"]: entry["sha256"] for entry in entries}
    doc: dict = {
        "format": 1,
        "seq": seq,
        "version": version,
        "revision": revision,
        "source": {"repo": REPO, "commit": source_commit},
        "files": entries,
        "treeSha256": tree_hash(file_hashes),
    }
    if res_tree_sha256 is not None:
        doc["resTreeSha256"] = res_tree_sha256
    return doc


def render_readme(
    manifest: dict, repo_id: str, *, dry_run: bool
) -> str:
    rows = []
    for entry in manifest["files"]:
        kind = entry.get("kind") or "data"
        feature = entry.get("featureSet") or "-"
        rows.append(
            f"| {entry['path']} | {kind} | {feature} | {entry['size']:,} | "
            f"{entry['sha256'][:16]}... |"
        )
    table = "\n".join(rows)
    los = "yes" if "resTreeSha256" in manifest else "no (weights release)"
    status = "DRY RUN" if dry_run else "PUBLISHED"
    return f"""---
license: other
license_name: synthetic-source-license-1.0
license_link: https://github.com/celestia-island/sysl
library_name: onnx
tags:
- world-of-warships
- decision-support
- onnx
---

# WoWSP decision models

Built-in ONNX decision/scoring models for WoWSP (a World of Warships
replay analysis and in-game overlay tool). The app loads these weights
through its signed model channel; this repository is the generated
release artifact, not a development home.

Status: {status}. Release seq {manifest['seq']}, generated
{manifest['version']} from GitHub commit {manifest['source']['commit']}.
Runtime manifest: [manifest.json](./manifest.json). LOS rasters included:
{los}.

## Files

| path | kind | feature set | bytes | sha256 |
| --- | --- | --- | --- | --- |
{table}

## Runtime contract

- manifest.json is the only entry point. It is Ed25519-signed with the
  same pinned keys as WoWSP's release-digest channel and pins every file
  above by sha256 plus the Hugging Face commit that contains it.
- Clients download each file from
  /resolve/<commit-sha>/<path> (an immutable pin), verify the sha256,
  then validate the ONNX kind and input widths before installing.
- featureSet values (fire-v1, move-v1, advice-e24, torpedo-e26d) are the
  app-featurizer contract. A featurizer change bumps the set name in an
  app release; never reuse a set name for different input semantics.
- Every file stays below 10 MB so an update stays small; the Hub may
  store binaries through Xet/LFS, in which case /resolve/ answers a signed
  CDN redirect that the downloader follows (Range/resume on the final
  host). No Xet client is needed.

## Provenance and reproducibility

- Source of truth: https://github.com/{REPO} at
  {manifest['source']['commit']}.
- The training and deployment scripts are snapshotted under training/
  for reproducibility; the model card and metrics live in that script tree
  (see scripts/experiments/README.md at the recorded commit).
- Training data: features derived from user-contributed replay sessions.
  No raw replay data, player identifiers or game files are published
  here.
- Do not edit files in this repository by hand; run
  scripts/publish_ai_models.py from the GitHub checkout instead.

## Licence and game-data notice

Licensed under the Synthetic Source License, Version 1.0 (SySL-1.0); see
[LICENSE](./LICENSE). The ship-attribute routing table is derived from
game data and the terrain-LOS rasters (when present) from published map
geometry; see [NOTICE.md](./NOTICE.md) for the provenance statement.
"""


def render_notice() -> str:
    return """# Provenance notice

This repository publishes generated decision-model artifacts for WoWSP.

- The ONNX weights were trained from features derived from
  user-contributed replay sessions. No raw replay data, player names,
  account identifiers or game installation files are published here.
- attrs/ship_attributes.json is derived from the game's GameParams data
  (a routing table: shipId -> weapon attributes) and is the same class of
  derived data the public WoWSP resource pack already ships publicly.
- If the optional LOS tree is present, its rasters were baked from the
  map geometry the public resource pack distributes. The manifest's
  resTreeSha256 records the exact resource-pack tree they were baked
  against.
- The authoritative source of this content is the GitHub repository
  langyo/wowsp; files here are generated by scripts/publish_ai_models.py
  and must not be edited in place.

Licensed under the Synthetic Source License 1.0; see LICENSE.
"""


def write_docs_stage(
    stage: Path,
    manifest: dict,
    *,
    repo_id: str,
    dry_run: bool,
) -> None:
    (stage / MANIFEST_NAME).write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (stage / "README.md").write_text(render_readme(manifest, repo_id, dry_run=dry_run), encoding="utf-8")
    shutil.copy2(REPO_ROOT / "LICENSE", stage / "LICENSE")
    (stage / "NOTICE.md").write_text(render_notice(), encoding="utf-8")
    (stage / "SOURCE.json").write_text(
        json.dumps(
            {
                "repo": REPO,
                "commit": manifest["source"]["commit"],
                "generatedAt": manifest["version"],
                "tool": "scripts/publish_ai_models.py",
                "treeSha256": manifest["treeSha256"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def summarise(manifest: dict, repo_id: str, *, dry_run: bool) -> None:
    print()
    print(f"  repo          {repo_id}")
    print(f"  seq           {manifest['seq']}")
    print(f"  version       {manifest['version']}")
    print(f"  source commit {manifest['source']['commit']}")
    print(f"  revision      {manifest['revision']}")
    print(f"  treeSha256    {manifest['treeSha256']}")
    print(f"  key           {manifest.get('key_id')} signed={bool(manifest.get('sig'))}")
    print(f"  los           {'included' if 'resTreeSha256' in manifest else 'not included'}")
    total = 0
    for entry in manifest["files"]:
        total += entry["size"]
        print(f"  file          {entry['path']:<44} {entry['size']:>10,}  {entry['sha256'][:16]}")
    print(f"  total         {total:,} bytes ({total / (1024 * 1024):.2f} MiB)")
    print(f"  mode          {'DRY RUN (nothing uploaded)' if dry_run else 'PUBLISHED'}")
    print()


def upload(repo_id: str, artifacts_dir: Path, seq: int) -> dict:
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:  # pragma: no cover - environment guard
        raise die("huggingface_hub is required for publishing: pip install huggingface_hub") from exc

    api = HfApi()
    api.create_repo(repo_id=repo_id, repo_type="model", exist_ok=True)
    artifact_commit = api.upload_folder(
        repo_id=repo_id,
        repo_type="model",
        folder_path=str(artifacts_dir),
        commit_message=f"Add decision model artifacts (seq {seq})",
        commit_description="Generated by scripts/publish_ai_models.py.",
    )
    oid = getattr(artifact_commit, "oid", None)
    if not oid:
        raise die("upload_folder did not return the artifact commit oid")
    return {"revision": oid, "api": api}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=DEFAULT_HF_REPO, help=f"Hugging Face repo id (default: {DEFAULT_HF_REPO})")
    parser.add_argument("--out-dir", default=str(REPO_ROOT / "scripts" / "experiments" / "out"))
    parser.add_argument("--los-dir", default=None, help="optional tree of <mapId>/terrain_los.npz rasters")
    parser.add_argument(
        "--res-tree-stamp",
        default=None,
        help="resource-pack stamp file used to record resTreeSha256 when --los-dir is given "
        "(default: %LOCALAPPDATA%/WoWSP/.res-version.json)",
    )
    parser.add_argument("--signing-key", default="~/.wowsp-signing/digest-main.key")
    parser.add_argument("--key-id", default=KEY_ID)
    parser.add_argument("--seq", type=int, default=None, help="override the next seq")
    parser.add_argument("--skip-training", action="store_true", help="skip the training-script snapshot")
    parser.add_argument("--dry-run", action="store_true", help="stage and sign locally, upload nothing")
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir).expanduser()
    if not out_dir.is_dir():
        raise die(f"--out-dir is not a directory: {out_dir}")

    staging = Path(tempfile.mkdtemp(prefix="wowsp-ai-release-"))
    artifacts = staging / "artifacts"
    docs = staging / "docs"
    artifacts.mkdir()
    docs.mkdir()

    try:
        entries, _ = stage_artifacts(artifacts, out_dir)
        res_tree = None
        if args.los_dir:
            los_entries, _ = stage_los(artifacts, Path(args.los_dir).expanduser())
            entries.extend(los_entries)
            stamp = args.res_tree_stamp
            if stamp is None:
                local_appdata = os.environ.get("LOCALAPPDATA")
                if local_appdata:
                    stamp = str(Path(local_appdata) / "WoWSP" / ".res-version.json")
            res_tree = read_los_tree_hash(Path(stamp).expanduser() if stamp else None)
            if res_tree is None:
                print(
                    "warning: LOS rasters are included but no resource-pack tree hash was "
                    "recorded; the client will treat the LOS as mismatched and skip it",
                    file=sys.stderr,
                )
        if not args.skip_training:
            stage_training(artifacts)

        version = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        source_commit = git_head()
        seq = args.seq if args.seq is not None else (1 if args.dry_run else fetch_previous_seq(args.repo) + 1)
        if seq < 1:
            raise die(f"--seq must be positive, got {seq}")

        seed = load_signing_seed(args)
        revision = "dry-run" if args.dry_run else None
        manifest = build_manifest(
            entries,
            seq=seq,
            revision=revision or "pending",
            version=version,
            source_commit=source_commit,
            res_tree_sha256=res_tree,
        )
        if args.dry_run:
            write_docs_stage(docs, catalog_signing.sign_doc(manifest, seed, args.key_id), repo_id=args.repo, dry_run=True)
            summarise(json.loads((docs / MANIFEST_NAME).read_text(encoding="utf-8")), args.repo, dry_run=True)
            print(f"  staged        {staging}")
            print("  dry run: no upload, no repository change")
            return 0

        uploaded = upload(args.repo, artifacts, seq)
        manifest["revision"] = uploaded["revision"]
        manifest = catalog_signing.sign_doc(manifest, seed, args.key_id)
        write_docs_stage(docs, manifest, repo_id=args.repo, dry_run=False)
        uploaded["api"].upload_folder(
            repo_id=args.repo,
            repo_type="model",
            folder_path=str(docs),
            commit_message=f"Publish signed manifest and model card (seq {seq})",
            commit_description="manifest.json is the runtime entry point; it pins revision "
            + manifest["revision"],
        )
        summarise(manifest, args.repo, dry_run=False)
        print(f"  hub           https://huggingface.co/{args.repo}")
        print(f"  mirror        https://hf-mirror.com/{args.repo}")
        print()
        print("  verify with:  python scripts/publish_ai_models.py --dry-run  (next seq)")
        return 0
    finally:
        if not args.dry_run:
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
