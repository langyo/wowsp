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
import copy
import hashlib
import json
import os
import re
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
REGISTRY_PATH = REPO_ROOT / "scripts" / "experiments" / "model_registry.json"
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
        "dest": "torpedo4_model.onnx",
        "src": "torpedo_model/final_torp4/fp32.onnx",
        "kind": "torpedo-t4-three-head",
        "feature_set": "torp4-v1",
        "quant": "fp32",
        "required": False,
    },
)

ATTRS_SRC = REPO_ROOT / "scripts" / "experiments" / "ship_attributes.json"
ATTRS_DEST = "ship_attributes.json"
ATTRS_REPO_PATH = "attrs/ship_attributes.json"


def die(message: str) -> "SystemExit":
    return SystemExit(f"error: {message}")



def load_registry(path: Path = REGISTRY_PATH) -> dict:
    if not Path(path).is_file():
        raise die(f"model registry not found: {path}")
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except ValueError as exc:
        raise die(f"model registry is not valid JSON: {exc}") from exc
    if not isinstance(doc, dict) or not str(doc.get("schema", "")).startswith("wowsp-model-registry"):
        raise die(f"{path}: unexpected registry schema")
    arch = doc.get("architectures")
    if not isinstance(arch, list) or not arch:
        raise die(f"{path}: architectures must be a non-empty list")
    return doc


def validate_models_against_registry(models, registry: dict) -> dict:
    current = {a["slot"]: a for a in registry["architectures"] if a.get("status") == "current"}
    legacy = {a["slot"]: a for a in registry["architectures"] if a.get("status") == "legacy"}
    if not current:
        raise die("registry has no current architectures")
    slots = {spec["dest"] for spec in models}
    missing = sorted(set(current) - slots)
    if missing:
        raise die("MODELS is missing current registry slots: " + ", ".join(missing))
    extra_legacy = sorted(set(legacy) & slots)
    if extra_legacy:
        raise die("legacy architecture must not be a current artifact: " + ", ".join(extra_legacy))
    for spec in models:
        arch = current.get(spec["dest"])
        if arch is None:
            raise die("MODELS slot not current in registry: " + spec["dest"])
        for key, reg_key in (("kind", "kind"), ("feature_set", "featureSet"), ("required", "required")):
            if key in spec and reg_key in arch and spec[key] != arch[reg_key]:
                raise die(f"{spec['dest']}: {key} {spec[key]!r} != registry {arch[reg_key]!r}")
        if arch.get("source") and spec.get("src") != arch["source"]:
            raise die(f"{spec['dest']}: src {spec.get('src')!r} != registry source {arch['source']!r}")
    for slot, arch in legacy.items():
        if slot in slots:
            raise die("legacy architecture still published: " + slot)
        tag = arch.get("legacyTag")
        if tag is not None and not re.fullmatch(r"legacy-.+-\d{8}", str(tag)):
            raise die(f"{slot}: legacyTag must end with an 8-digit date: {tag!r}")
    return current


def _check_date(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{8}", value):
        raise die("legacy tag date must be YYYYMMDD: " + repr(value))
    return value


def legacy_tag_plan(prev_seq: int, date: str, registry: dict, prev_revision: str | None = None) -> list[dict]:
    """Tags to create on the PREVIOUS artifact commit (never the new one)."""
    _check_date(date)
    if not isinstance(prev_seq, int) or prev_seq <= 0:
        return []
    plan = [{"tag": f"legacy-{prev_seq}-{date}", "revision": prev_revision,
             "reason": f"archive previous artifact seq {prev_seq}"}]
    for arch in registry["architectures"]:
        if arch.get("status") != "legacy":
            continue
        arch_id = arch.get("architectureId") or arch.get("featureSet") or arch.get("kind")
        tag = f"legacy-{arch_id}-{date}"
        if arch.get("legacyTag") and str(arch["legacyTag"]).endswith(date):
            tag = str(arch["legacyTag"])
        plan.append({"tag": tag, "revision": prev_revision,
                     "reason": "retired architecture " + str(arch.get("kind"))})
    seen = set()
    unique = []
    for item in plan:
        if item["tag"] in seen:
            continue
        seen.add(item["tag"])
        unique.append(item)
    return unique


def create_legacy_tags(repo_id: str, plan: list[dict]) -> None:
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:  # pragma: no cover - environment guard
        raise die("huggingface_hub is required for publishing: pip install huggingface_hub") from exc
    api = HfApi()
    for item in plan:
        revision = item.get("revision")
        if not revision:
            raise die("legacy tag " + item["tag"] + " has no previous artifact revision; aborting upload")
        try:
            api.create_tag(repo_id=repo_id, tag=item["tag"], revision=revision,
                           repo_type="model", exist_ok=True)
        except Exception as exc:  # noqa: BLE001 - any tag failure must abort the upload
            raise die(f"cannot create legacy tag {item['tag']} on {revision}: {exc}") from exc
        print(f"  legacy tag    {item['tag']} -> {revision} (archive; not in manifest)")

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


def fetch_previous_manifest(repo_id: str) -> dict | None:
    """The currently published manifest (None when the repo is fresh)."""
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
        return None
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def fetch_previous_seq(repo_id: str) -> int:
    doc = fetch_previous_manifest(repo_id)
    seq = (doc or {}).get("seq")
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
    manifest: dict, repo_id: str, *, dry_run: bool, registry: dict, legacy_plan: list[dict]
) -> str:
    rows = []
    for entry in manifest["files"]:
        kind = entry.get("kind") or "data"
        feature = entry.get("featureSet") or "-"
        rows.append(
            f"| {entry['path']} | {kind} | {feature} | {entry['size']:,} | "
            f"{entry['sha256'][:16]}... |"
        )
    arch_rows = []
    for arch in registry["architectures"]:
        retired = arch.get("legacyTag") or (arch.get("retired") and "retired " + str(arch["retired"])) or "-"
        arch_rows.append(
            "| " + arch["slot"] + " | " + arch["kind"] + " | " + arch["featureSet"] + " | "
            + str(arch.get("heads", "-")) + " | " + ("yes" if arch.get("required") else "no")
            + " | " + arch["status"] + " | " + str(retired) + " |"
        )
    table = "\n".join(rows)
    arch_table = "\n".join(arch_rows)
    legacy_tags = ", ".join(item["tag"] for item in legacy_plan) or "none"
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

## Architecture & weights declaration

The GitHub registry scripts/experiments/model_registry.json is the source of
truth; this repository is its generated artifact.

| slot | kind | feature set | heads | required | status | retired / legacy tag |
| --- | --- | --- | --- | --- | --- | --- |
{arch_table}

Current artifacts: fire_model.onnx, move_model.onnx, advice_fire_model.onnx
and torpedo4_model.onnx (T4: 49-dim global input, three heads, optional).
The T2 torpedo_model.onnx (torpedo-e26d / torpedo-three-head) is legacy:
retired 2026-11-10, removed from the current artifacts and the manifest,
archived only as Git tags.

Update rules: a post-training weight update bumps seq; retired weights are
archived as tags on the previous artifact commit; without a new architecture
never change slot / kind / featureSet. Legacy tags are archive-only and never
enter manifest.json.

Legacy tags planned for this publish: {legacy_tags}. They target the previous
artifact commit (resolved from the previous manifest revision), never the new
commit.

## Runtime contract

- manifest.json is the only entry point. It is Ed25519-signed with the
  same pinned keys as WoWSP's release-digest channel and pins every file
  above by sha256 plus the Hugging Face commit that contains it.
- Clients download each file from
  /resolve/<commit-sha>/<path> (an immutable pin), verify the sha256,
  then validate the ONNX kind and input widths before installing.
- featureSet values (fire-v1, move-v1, advice-e24, torp4-v1; the T2 torpedo-e26d is legacy) are the
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
    registry: dict,
    legacy_plan: list[dict],
) -> None:
    (stage / MANIFEST_NAME).write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (stage / "README.md").write_text(
        render_readme(manifest, repo_id, dry_run=dry_run, registry=registry, legacy_plan=legacy_plan),
        encoding="utf-8")
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


def run_selftest() -> int:
    """Offline checks for registry, legacy tag plan and the model card."""
    registry = load_registry()
    current = validate_models_against_registry(MODELS, registry)
    slots = [spec["dest"] for spec in MODELS]
    assert "torpedo4_model.onnx" in slots, slots
    assert "torpedo_model.onnx" not in slots, "T2 must not be a current artifact"
    t4 = current["torpedo4_model.onnx"]
    assert t4["kind"] == "torpedo-t4-three-head"
    assert t4["featureSet"] == "torp4-v1"
    assert t4["heads"] == 3 and t4["required"] is False
    assert t4["globalDim"] == 49 and t4["extraDim"] == 22
    assert t4["input"] == {"entity": [1, 24, 15], "global_feat": [1, 49], "mask": [1, 24]}
    legacy = [a for a in registry["architectures"] if a.get("status") == "legacy"]
    assert any(a["slot"] == "torpedo_model.onnx" and a.get("retired") == "2026-11-10" for a in legacy)
    t2 = next(a for a in legacy if a["slot"] == "torpedo_model.onnx")
    assert t2["legacyTag"] == "legacy-torpedo-e26d-20261110", t2.get("legacyTag")
    plan = legacy_tag_plan(2, "20261110", registry, None)
    tags = [item["tag"] for item in plan]
    assert tags == ["legacy-2-20261110", "legacy-torpedo-e26d-20261110"], tags
    assert all(tag.endswith("20261110") for tag in tags)
    assert legacy_tag_plan(0, "20261110", registry, None) == []
    for bad in ("2026-11-10", "2026111", "", "20261110x"):
        try:
            _check_date(bad)
        except SystemExit:
            continue
        raise SystemExit("[selftest] invalid legacy date accepted: " + repr(bad))
    bad_registry = copy.deepcopy(registry)
    for arch in bad_registry["architectures"]:
        if arch["slot"] == "torpedo4_model.onnx":
            arch["featureSet"] = "wrong-v1"
    try:
        validate_models_against_registry(MODELS, bad_registry)
    except SystemExit:
        pass
    else:
        raise SystemExit("[selftest] registry mismatch not rejected")
    fake_manifest = {
        "seq": 3,
        "version": "2026-11-10T00:00:00Z",
        "source": {"repo": REPO, "commit": "deadbeef"},
        "revision": "abc123",
        "treeSha256": "0" * 64,
        "files": [{"path": "onnx/torpedo4_model.onnx", "kind": "torpedo-t4-three-head",
                   "featureSet": "torp4-v1", "size": 1, "sha256": "0" * 64}],
    }
    card = render_readme(fake_manifest, "langyo/wowsp-d1", dry_run=True,
                         registry=registry, legacy_plan=plan)
    for needle in ("Architecture & weights declaration", "torpedo4_model.onnx",
                   "torpedo_model.onnx", "legacy-torpedo-e26d-20261110",
                   "legacy-2-20261110", "retired 2026-11-10"):
        assert needle in card, "model card missing " + needle
    print("PASS")
    return 0


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
    parser.add_argument("--legacy-date", default=None,
                        help="YYYYMMDD legacy-tag date (default: registry legacyArchive.date)")
    parser.add_argument("--prev-seq", type=int, default=None,
                        help="dry-run: previous artifact seq (default: registry legacyArchive.previousSeq)")
    parser.add_argument("--prev-revision", default=None,
                        help="dry-run: previous artifact revision label; real runs resolve it from HF")
    parser.add_argument("--selftest", action="store_true", help="offline registry/tag/card checks")
    args = parser.parse_args(argv)

    if args.selftest:
        return run_selftest()
    registry = load_registry()
    validate_models_against_registry(MODELS, registry)

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
        legacy_date = str(args.legacy_date or registry.get("legacyArchive", {}).get("date") or "")
        _check_date(legacy_date)
        if args.dry_run:
            prev_seq = (args.prev_seq if args.prev_seq is not None
                        else int(registry.get("legacyArchive", {}).get("previousSeq", 0) or 0))
            prev_revision = args.prev_revision or "previous artifact commit (resolved from HF manifest.revision at publish)"
            seq = args.seq if args.seq is not None else 1
        else:
            previous = fetch_previous_manifest(args.repo)
            prev_seq = (args.prev_seq if args.prev_seq is not None
                        else int((previous or {}).get("seq", 0) or 0))
            prev_revision = (previous or {}).get("revision")
            seq = args.seq if args.seq is not None else prev_seq + 1
        if seq < 1:
            raise die(f"--seq must be positive, got {seq}")
        legacy_plan = legacy_tag_plan(prev_seq, legacy_date, registry, prev_revision)
        if legacy_plan and not args.dry_run and not prev_revision:
            raise die("previous artifact revision is unavailable; refusing to publish without archiving legacy tags")

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
            signed = catalog_signing.sign_doc(manifest, seed, args.key_id)
            write_docs_stage(docs, signed, repo_id=args.repo, dry_run=True,
                             registry=registry, legacy_plan=legacy_plan)
            summarise(json.loads((docs / MANIFEST_NAME).read_text(encoding="utf-8")), args.repo, dry_run=True)
            print("  legacy archive plan (dry run; tags target the previous artifact revision):")
            if not legacy_plan:
                print("  legacy tags   none (no previous artifact seq)")
            for item in legacy_plan:
                print(f"  legacy tag    {item['tag']}  <-  {prev_revision}")
            print(f"  staged        {staging}")
            print("  dry run: no upload, no repository change")
            return 0

        if legacy_plan:
            create_legacy_tags(args.repo, legacy_plan)
        uploaded = upload(args.repo, artifacts, seq)
        manifest["revision"] = uploaded["revision"]
        manifest = catalog_signing.sign_doc(manifest, seed, args.key_id)
        write_docs_stage(docs, manifest, repo_id=args.repo, dry_run=False,
                         registry=registry, legacy_plan=legacy_plan)
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
