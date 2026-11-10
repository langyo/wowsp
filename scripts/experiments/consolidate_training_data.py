#!/usr/bin/env python3
"""E26 data snapshot v1: consolidate the torpedo training corpus into a frozen,
hardlinked layout under out/torpedo_model/dataset_v1/.

Deliverables:
  dataset/        dataset_{region}_2s.jsonl   (hardlinks to full/)
  click/          click_{region}.jsonl        (hardlinks to e26e-g/)
  outcome_r120/   outcome_{region}.jsonl      (hardlinks to e26e-j/r120/)
  manifest.json   counts / sha256 / feature contract / GroupKFold5 split / provenance
  scripts/experiments/training_data_manifest.json  frozen copy (tracked)

No raw data is copied (hardlink only; fail on cross-volume), no source file is modified,
no HF upload, no model/retrain. --verify rechecks the snapshot; --selftest exercises the
whole path on tiny synthetic files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
REGIONS = ("apac", "eu", "na", "own")
DATASET_REL = "full/dataset_{region}_2s.jsonl"
CLICK_REL = "e26e-g/click_{region}.jsonl"
OUTCOME_REL = "e26e-j/r120/outcome_{region}.jsonl"
EXTERNAL_REL = "e26e-z/dataset_external.jsonl"
OOF_REL = "e26e-g/e26e_g_oof.npz"
LAYOUT = {"dataset": "dataset", "click": "click", "outcome_r120": "outcome_r120"}
TARGET_NAME = {"dataset": "dataset_{region}_2s.jsonl",
               "click": "click_{region}.jsonl",
               "outcome_r120": "outcome_{region}.jsonl"}
SCHEMA = "wowsp-torpedo-training-snapshot-v1"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_lines_and_replays(path: Path) -> tuple:
    """Return (line_count, Counter(replayId)) in one streaming pass."""
    lines = 0
    replays = Counter()
    needle = b'"replayId":"'
    with Path(path).open("rb") as f:
        for line in f:
            lines += 1
            i = line.find(needle)
            if i >= 0:
                start = i + len(needle)
                end = line.find(b'"', start)
                if end > start:
                    replays[line[start:end].decode("utf-8", "replace")] += 1
    return lines, replays


def count_lines(path: Path) -> int:
    n = 0
    with Path(path).open("rb") as f:
        for _ in f:
            n += 1
    return n


def link_or_check(src: Path, dst: Path) -> None:
    src, dst = Path(src), Path(dst)
    if not src.is_file():
        raise SystemExit("[data-v1] source missing: " + str(src))
    if dst.exists():
        try:
            same = dst.samefile(src)
        except OSError:
            same = False
        if not same:
            raise SystemExit("[data-v1] target exists but is not the same file: " + str(dst))
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dst)
    except OSError as exc:
        raise SystemExit("[data-v1] hardlink failed (cross-volume?): " + str(src) + " -> " + str(dst)
                         + " (" + str(exc) + "); refusing to copy raw data") from exc


def load_oof(path: Path) -> dict:
    z = np.load(path, allow_pickle=True)
    need = ("fold", "groupCode", "groupNames", "rowIndex", "meta")
    missing = [k for k in need if k not in z.files]
    if missing:
        raise SystemExit("[data-v1] OOF npz missing: " + ", ".join(missing))
    meta = json.loads(str(z["meta"].tolist()))
    fold = z["fold"].astype(np.int64)
    gc = z["groupCode"].astype(np.int64)
    names = [str(x) for x in z["groupNames"].tolist()]
    rowidx = z["rowIndex"].astype(np.int64)
    if len(fold) != len(gc) or len(fold) != len(rowidx):
        raise SystemExit("[data-v1] OOF arrays disagree in length")
    if len(names) != len(set(names)):
        raise SystemExit("[data-v1] OOF groupNames not unique")
    if len(np.unique(rowidx)) != len(rowidx):
        raise SystemExit("[data-v1] OOF rowIndex not unique")
    if not np.all(np.diff(rowidx) > 0):
        raise SystemExit("[data-v1] OOF rowIndex is not strictly increasing")
    group_rows = Counter(int(g) for g in gc)
    group_fold: dict = {}
    for g in group_rows:
        folds = np.unique(fold[gc == g])
        if len(folds) != 1:
            raise SystemExit("[data-v1] group " + str(g) + " spans folds " + str(folds.tolist()))
        group_fold[g] = int(folds[0])
    folds = sorted(set(int(f) for f in fold))
    fold_list = []
    for f in folds:
        entries = [{"replay": names[g], "rows": int(group_rows[g])}
                   for g in range(len(names)) if group_fold[g] == f]
        entries.sort(key=lambda e: e["replay"])
        fold_list.append({"fold": f, "rows": int(sum(e["rows"] for e in entries)), "replays": entries})
    return {"rows": int(len(fold)), "replays": len(names), "folds": fold_list, "meta": meta,
            "groupNames": names, "groupRows": {names[g]: int(group_rows[g]) for g in group_rows},
            "foldOfGroup": {names[g]: group_fold[g] for g in group_rows}}


def git_commit() -> str:
    try:
        out = subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=20)
        return out.stdout.strip() if out.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def build_snapshot(source_root: Path, target_root: Path, manifest_out: Path | None,
                   expected_external_replays: int = 18, expected_rows: int = 0) -> dict:
    source_root = Path(source_root)
    target_root = Path(target_root)
    for role in LAYOUT:
        (target_root / LAYOUT[role]).mkdir(parents=True, exist_ok=True)
    files = []
    region_rows: dict = {}
    region_replays: dict = {}
    region_replay_counts: dict = {}
    replay_owner: dict = {}
    for region in REGIONS:
        src = source_root / DATASET_REL.format(region=region)
        lines, replays = scan_lines_and_replays(src)
        if lines <= 0:
            raise SystemExit("[data-v1] empty dataset shard: " + str(src))
        for r in replays:
            if r in replay_owner:
                raise SystemExit("[data-v1] replay duplicated across shards: " + r
                                 + " (" + replay_owner[r] + " and " + region + ")")
            replay_owner[r] = region
        region_rows[region] = lines
        region_replays[region] = set(replays)
        region_replay_counts[region] = dict(replays)
        dst = target_root / LAYOUT["dataset"] / TARGET_NAME["dataset"].format(region=region)
        link_or_check(src, dst)
        files.append({"role": "dataset", "region": region, "path": dst.relative_to(target_root).as_posix(),
                      "source": Path(DATASET_REL.format(region=region)).as_posix(), "bytes": src.stat().st_size,
                      "lines": int(lines), "rows": int(lines), "replays": len(replays),
                      "sha256": sha256_file(src), "hardlink": True})
    total_rows = sum(region_rows.values())
    training_replays = set(replay_owner)
    if len(training_replays) != len(replay_owner):
        raise SystemExit("[data-v1] replay set collapsed unexpectedly")
    for role, rel_fmt in (("click", CLICK_REL), ("outcome_r120", OUTCOME_REL)):
        for region in REGIONS:
            src = source_root / rel_fmt.format(region=region)
            lines = count_lines(src)
            if lines != region_rows[region]:
                raise SystemExit("[data-v1] " + role + " " + region + " rows " + str(lines)
                                 + " != dataset rows " + str(region_rows[region]))
            dst = target_root / LAYOUT[role] / TARGET_NAME[role].format(region=region)
            link_or_check(src, dst)
            files.append({"role": role, "region": region, "path": dst.relative_to(target_root).as_posix(),
                          "source": Path(rel_fmt.format(region=region)).as_posix(), "bytes": src.stat().st_size,
                          "lines": int(lines), "rows": int(lines),
                          "sha256": sha256_file(src), "hardlink": True})
    if sum(f["rows"] for f in files if f["role"] == "click") != total_rows:
        raise SystemExit("[data-v1] click total rows != dataset total rows")
    if sum(f["rows"] for f in files if f["role"] == "outcome_r120") != total_rows:
        raise SystemExit("[data-v1] outcome total rows != dataset total rows")
    oof = load_oof(source_root / OOF_REL)
    if oof["rows"] != total_rows:
        raise SystemExit("[data-v1] OOF rows " + str(oof["rows"]) + " != dataset rows " + str(total_rows))
    if expected_rows and total_rows != expected_rows:
        raise SystemExit("[data-v1] dataset rows " + str(total_rows) + " != expected " + str(expected_rows))
    if set(oof["groupNames"]) != training_replays:
        missing = sorted(set(oof["groupNames"]) - training_replays)[:5]
        extra = sorted(training_replays - set(oof["groupNames"]))[:5]
        raise SystemExit("[data-v1] OOF replay set != dataset replay set; missing=" + str(missing) + " extra=" + str(extra))
    # cross-check per-replay row counts from the dataset scans (reuse pass 1 counts)
    replay_rows = Counter()
    for region in REGIONS:
        replay_rows.update(region_replay_counts[region])
    for name, rows in oof["groupRows"].items():
        if int(replay_rows.get(name, -1)) != int(rows):
            raise SystemExit("[data-v1] replay row mismatch " + name + ": dataset " + str(replay_rows.get(name))
                             + " vs OOF " + str(rows))
    ext_path = source_root / EXTERNAL_REL
    ext_lines, ext_replays = scan_lines_and_replays(ext_path)
    overlap = sorted(set(ext_replays) & training_replays)
    if len(ext_replays) != expected_external_replays:
        raise SystemExit("[data-v1] external replays " + str(len(ext_replays)) + " != expected "
                         + str(expected_external_replays))
    if overlap:
        raise SystemExit("[data-v1] DATA LEAK: external replays overlap training: " + ", ".join(overlap[:10]))
    meta = oof["meta"]
    feature_contract = {
        "feature_version": int(meta.get("feature_version", 2)),
        "feature_set": str(meta.get("feature_set", "torp4")),
        "entity_shape": [24, 15],
        "global_dim": 49,
        "global_breakdown": {"core": 27, "torp2": 11, "torp3": 6, "torp4": 5},
        "extra_dim": int(meta.get("extra_dim", 22)),
        "classes": ["Destroyer", "Cruiser", "Battleship", "Submarine", "unknown"],
        "label_windows_s": {"labelB": 2, "outcome_r120": 120},
    }
    if feature_contract["feature_version"] != 2 or feature_contract["feature_set"] != "torp4":
        raise SystemExit("[data-v1] unexpected feature contract in OOF meta: " + json.dumps(feature_contract))
    if feature_contract["global_dim"] != sum(feature_contract["global_breakdown"].values()):
        raise SystemExit("[data-v1] global_dim breakdown mismatch")
    split = {"method": str(meta.get("split_mode", "GroupKFold by replayId")),
             "folds": len(oof["folds"]),
             "seed": int(meta.get("seed", 0)),
             "rows": oof["rows"], "replays": oof["replays"],
             "foldList": oof["folds"]}
    manifest = {
        "schema": SCHEMA,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "source_root_label": "scripts/experiments/out/torpedo_model",
        "layout_root_label": "out/torpedo_model/dataset_v1",
        "feature_contract": feature_contract,
        "corpus": {"rows": total_rows, "replays": len(training_replays), "shards": len(REGIONS),
                   "regions": {r: {"rows": region_rows[r], "replays": len(region_replays[r])} for r in REGIONS}},
        "files": files,
        "split": split,
        "excluded_external": {"path": EXTERNAL_REL, "rows": int(ext_lines), "replays": len(ext_replays),
                              "overlapWithTraining": 0, "replaysList": sorted(ext_replays)},
        "provenance": {"gitCommit": git_commit(), "script": "scripts/experiments/consolidate_training_data.py",
                       "note": "raw JSONL/hardlinks live only under out/ (gitignored); this manifest is the tracked artifact"},
    }
    (target_root / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    # The tracked copy carries only aggregate/validation data: no replay IDs, no foldList.
    compact = {
        "schema": SCHEMA,
        "created_utc": manifest["created_utc"],
        "source_root_label": manifest["source_root_label"],
        "layout_root_label": manifest["layout_root_label"],
        "feature_contract": manifest["feature_contract"],
        "corpus": manifest["corpus"],
        "files": manifest["files"],
        "split": {
            "method": manifest["split"]["method"],
            "folds": manifest["split"]["folds"],
            "seed": manifest["split"]["seed"],
            "rows": manifest["split"]["rows"],
            "replays": manifest["split"]["replays"],
            "foldSummaries": [{"fold": f["fold"], "rows": f["rows"], "replays": len(f["replays"])}
                              for f in manifest["split"]["foldList"]],
        },
        "excluded_external": {
            "path": manifest["excluded_external"]["path"],
            "rows": manifest["excluded_external"]["rows"],
            "replays": manifest["excluded_external"]["replays"],
            "overlapWithTraining": manifest["excluded_external"]["overlapWithTraining"],
        },
        "provenance": manifest["provenance"],
        "note": ("tracked aggregate manifest: the full fold->replay list and external replay names live only in "
                 "out/torpedo_model/dataset_v1/manifest.json (gitignored)"),
    }
    if manifest_out:
        manifest_out = Path(manifest_out)
        manifest_out.parent.mkdir(parents=True, exist_ok=True)
        manifest_out.write_text(json.dumps(compact, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print("[data-v1] rows " + format(total_rows, ",") + " replays " + str(len(training_replays))
          + " external " + str(len(ext_replays)) + " (overlap 0)")
    print("[data-v1] folds " + json.dumps({f["fold"]: f["rows"] for f in oof["folds"]}))
    return manifest


def verify_snapshot(source_root: Path, target_root: Path, manifest_path: Path,
                    expected_external_replays: int = 18) -> dict:
    source_root = Path(source_root)
    target_root = Path(target_root)
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if manifest.get("schema") != SCHEMA:
        raise SystemExit("[data-v1] manifest schema mismatch: " + str(manifest.get("schema")))
    failures = []
    files = manifest["files"]
    for f in files:
        src = source_root / f["source"]
        dst = target_root / f["path"]
        if not dst.is_file():
            failures.append("missing target " + str(dst))
            continue
        try:
            if not dst.samefile(src):
                failures.append("not a hardlink " + str(dst))
        except OSError:
            failures.append("cannot compare hardlink " + str(dst))
        if dst.stat().st_size != f["bytes"]:
            failures.append("bytes mismatch " + str(dst))
        lines = count_lines(dst)
        if lines != f["lines"]:
            failures.append("lines mismatch " + str(dst) + ": " + str(lines) + " != " + str(f["lines"]))
        digest = sha256_file(dst)
        if digest != f["sha256"]:
            failures.append("sha256 mismatch " + str(dst))
    total_rows = sum(int(f["rows"]) for f in files if f["role"] == "dataset")
    if total_rows != manifest["corpus"]["rows"]:
        failures.append("corpus rows mismatch")
    if sum(int(f["rows"]) for f in files if f["role"] == "click") != total_rows:
        failures.append("click total mismatch")
    if sum(int(f["rows"]) for f in files if f["role"] == "outcome_r120") != total_rows:
        failures.append("outcome total mismatch")
    oof = load_oof(source_root / OOF_REL)
    if oof["rows"] != total_rows or oof["replays"] != manifest["corpus"]["replays"]:
        failures.append("OOF rows/replays mismatch")
    if len(oof["folds"]) != manifest["split"]["folds"]:
        failures.append("fold count mismatch")
    ext_lines, ext_replays = scan_lines_and_replays(source_root / EXTERNAL_REL)
    if len(ext_replays) != expected_external_replays:
        failures.append("external replay count mismatch")
    overlap = sorted(set(ext_replays) & set(oof["groupNames"]))
    if overlap:
        failures.append("external/training replay overlap: " + ", ".join(overlap[:5]))
    if int(ext_lines) != manifest["excluded_external"]["rows"]:
        failures.append("external rows mismatch")
    if failures:
        for msg in failures:
            print("[data-v1] VERIFY FAIL: " + msg)
        raise SystemExit(1)
    print("[data-v1] VERIFY PASS: " + str(len(files)) + " files, rows " + format(total_rows, ",")
          + ", replays " + str(manifest["corpus"]["replays"]) + ", folds " + str(manifest["split"]["folds"])
          + ", external excluded " + str(len(ext_replays)) + " (overlap 0)")
    return manifest


def _write_row(path: Path, replay: str, t: float, ship: int, extra: str = "") -> None:
    rec = {"replayId": replay, "t": t, "shipId": ship, "featureVersion": 2,
           "gameMode": "pvp", "mapName": "m", "replayVersion": "v"}
    with Path(path).open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + chr(10))


def run_selftest() -> int:
    root = Path(tempfile.mkdtemp(prefix="data-v1-selftest-"))
    src = root / "src"
    (src / "full").mkdir(parents=True)
    (src / "e26e-g").mkdir(parents=True)
    (src / "e26e-j" / "r120").mkdir(parents=True)
    (src / "e26e-z").mkdir(parents=True)
    # 5 replays / 10 rows across 4 regions (2 rows each replay); folds 0..4 one replay each
    replays = ["r" + str(i) for i in range(5)]
    region_counts = {"apac": 2, "eu": 1, "na": 1, "own": 1}
    all_rows = []
    for region in REGIONS:
        ds = src / "full" / ("dataset_" + region + "_2s.jsonl")
        cl = src / "e26e-g" / ("click_" + region + ".jsonl")
        oc = src / "e26e-j" / "r120" / ("outcome_" + region + ".jsonl")
        ds.write_text("", encoding="utf-8")
        cl.write_text("", encoding="utf-8")
        oc.write_text("", encoding="utf-8")
        for _ in range(region_counts[region]):
            pass
    # distribute replays to regions: apac r0,r1; eu r2; na r3; own r4
    assign = {"apac": ["r0", "r1"], "eu": ["r2"], "na": ["r3"], "own": ["r4"]}
    for region, reps in assign.items():
        ds = src / "full" / ("dataset_" + region + "_2s.jsonl")
        cl = src / "e26e-g" / ("click_" + region + ".jsonl")
        oc = src / "e26e-j" / "r120" / ("outcome_" + region + ".jsonl")
        for rep in reps:
            for k in range(2):
                _write_row(ds, rep, 1.0 + k, 100, "")
                cl.write_text(cl.read_text(encoding="utf-8") + json.dumps({"t": 1.0 + k}) + chr(10), encoding="utf-8")
                oc.write_text(oc.read_text(encoding="utf-8") + json.dumps({"torpFiredFish": 1, "torpHits": 0}) + chr(10), encoding="utf-8")
                all_rows.append((rep, 100))
    fold_of = {r: i for i, r in enumerate(replays)}
    names = replays
    row_name = []
    row_fold = []
    for region, reps in assign.items():
        for rep in reps:
            for _ in range(2):
                row_name.append(rep)
                row_fold.append(fold_of[rep])
    # row order must follow shard concatenation: apac, eu, na, own
    ordered_names = []
    ordered_folds = []
    for region in REGIONS:
        for rep in assign[region]:
            for _ in range(2):
                ordered_names.append(rep)
                ordered_folds.append(fold_of[rep])
    np.savez_compressed(src / "e26e-g" / "e26e_g_oof.npz",
                        fold=np.asarray(ordered_folds, dtype=np.int64),
                        groupCode=np.asarray([names.index(r) for r in ordered_names], dtype=np.int32),
                        groupNames=np.asarray(names, dtype=object),
                        rowIndex=np.arange(len(ordered_names), dtype=np.int64),
                        meta=np.asarray(json.dumps({"feature_version": 2, "feature_set": "torp4",
                                                    "extra_dim": 22, "folds": 5, "seed": 0,
                                                    "split_mode": "5-fold GroupKFold by replayId",
                                                    "rows": len(ordered_names), "replays": len(names)}),
                                        dtype=object))
    # external: 2 disjoint replays
    ext = src / "e26e-z" / "dataset_external.jsonl"
    ext.write_text(json.dumps({"replayId": "ext1", "t": 1.0}, separators=(",", ":")) + chr(10)
                   + json.dumps({"replayId": "ext2", "t": 1.0}, separators=(",", ":")) + chr(10), encoding="utf-8")
    target = root / "out" / "torpedo_model" / "dataset_v1"
    manifest_out = root / "manifest.json"
    m = build_snapshot(src, target, manifest_out, expected_external_replays=2)
    assert m["corpus"]["rows"] == 10 and m["corpus"]["replays"] == 5, m
    assert m["split"]["folds"] == 5 and m["split"]["seed"] == 0
    assert m["feature_contract"]["global_dim"] == 49
    assert (target / "dataset" / "dataset_apac_2s.jsonl").samefile(src / "full" / "dataset_apac_2s.jsonl")
    verify_snapshot(src, target, manifest_out, expected_external_replays=2)
    # tracked compact manifest: aggregate only, no replay IDs, POSIX paths, small
    tracked = json.loads(manifest_out.read_text(encoding="utf-8"))
    assert "foldList" not in tracked["split"], "tracked manifest must not carry foldList"
    assert "replaysList" not in tracked["excluded_external"], "tracked manifest must not carry replaysList"
    tracked_text = manifest_out.read_text(encoding="utf-8")
    for r in replays:
        assert ('"' + r + '"') not in tracked_text, "tracked manifest leaks replay id " + r
    for f in tracked["files"]:
        assert "\\" not in f["path"] and "\\" not in f["source"], f
    assert manifest_out.stat().st_size < 15000, manifest_out.stat().st_size
    assert len(tracked["split"]["foldSummaries"]) == 5
    assert all(set(x.keys()) == {"fold", "rows", "replays"} for x in tracked["split"]["foldSummaries"])
    # the local full manifest keeps the detailed fold->replay list and verifies too
    full = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    assert "foldList" in full["split"] and "replaysList" in full["excluded_external"]
    for f in full["files"]:
        assert "\\" not in f["path"] and "\\" not in f["source"], f
    verify_snapshot(src, target, target / "manifest.json", expected_external_replays=2)
    # hardlink tamper: replace with a copy -> verify must fail
    bad = target / "dataset" / "dataset_eu_2s.jsonl"
    data = bad.read_bytes()
    bad.unlink()
    bad.write_bytes(data)
    try:
        verify_snapshot(src, target, manifest_out, expected_external_replays=2)
    except SystemExit:
        pass
    else:
        raise SystemExit("[data-v1] selftest: verify did not catch a non-hardlink target")
    # external leak: add a training replay -> build must fail
    with ext.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"replayId": "r0", "t": 1.0}, separators=(",", ":")) + chr(10))
    try:
        build_snapshot(src, target, manifest_out, expected_external_replays=3)
    except SystemExit:
        pass
    else:
        raise SystemExit("[data-v1] selftest: build did not catch an external/training overlap")
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26 data snapshot v1 (hardlinked, validated, manifest)")
    ap.add_argument("--source-root", default=str(HERE / "out" / "torpedo_model"),
                    help="raw corpus root (out/torpedo_model); default relative to this script")
    ap.add_argument("--target-root", default="", help="snapshot root (default: <source-root>/dataset_v1)")
    ap.add_argument("--manifest-out", default=str(HERE / "training_data_manifest.json"),
                    help="tracked frozen manifest path")
    ap.add_argument("--expected-external-replays", type=int, default=18)
    ap.add_argument("--expected-rows", type=int, default=0)
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    source_root = Path(args.source_root)
    target_root = Path(args.target_root) if args.target_root else source_root / "dataset_v1"
    if args.verify:
        manifest = Path(args.manifest_out)
        if not manifest.is_file():
            raise SystemExit("[data-v1] manifest not found: " + str(manifest))
        verify_snapshot(source_root, target_root, manifest, args.expected_external_replays)
        return 0
    t0 = time.time()
    build_snapshot(source_root, target_root, Path(args.manifest_out),
                   expected_external_replays=args.expected_external_replays,
                   expected_rows=args.expected_rows)
    print("[data-v1] done in " + format(time.time() - t0, ".1f") + "s -> " + str(target_root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
