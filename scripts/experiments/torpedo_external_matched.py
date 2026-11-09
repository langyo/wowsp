#!/usr/bin/env python3
"""E26e-ag: matched-domain external subset for the T4 torpedo holdout.

Streams the in-distribution 4-shard corpus once to collect the SEEN map / shipClass /
mode / replayVersion vocabularies, then marks each external row (E26e-aa predictions):
  matched_mapclass = known ship class AND map seen in-dist,
  matched_strict   = matched_mapclass AND mode seen AND version seen,
  unmatched        = the rest (unknown class or unseen map).
Recomputes headB (AUPRC/top/AUC/ECE/meanProb) and headC outcome (fired/hits lift/CI) on
full / matched / unmatched, with mode/version breakdowns. Descriptive only (no retrain).
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np

import sys
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from train_torpedo_model import (  # noqa: E402
    class_of, head_b_metrics, holdout_outcome_metrics, load_ship_classes,
)

MIN_OUTCOME_LAUNCHED = 10
MIN_OUTCOME_FIRED = 20
MIN_OUTCOME_HITS = 5
EXTERNAL_FULL = {"headB_auprcMultiple": 1.8616, "headB_topDecileLift": 2.4292, "headB_rocAuc": 0.6017,
                 "headB_ece15bin": 0.016778, "headB_meanProbB": 0.029006, "headB_baseRate": 0.012227,
                 "headB_canLaunchRows": 3026, "headB_positives": 37,
                 "headC_topDecileLift": 1.9896, "headC_launchedRows": 37, "headC_firedFish": 115,
                 "headC_hits": 17}
IN_DIST_T4 = {"headB_auprcMultiple": 2.599, "headB_topDecileLift": 2.905, "headB_rocAuc": 0.7273,
              "headB_ece15bin": 0.024565, "headC_outcomeLift": 2.1997}
EXTERNAL_MODE_REF = {
    "pve": {"headB_auprcMultiple": 3.558, "headB_rocAuc": 0.630, "headB_ece15bin": 0.009014,
            "headB_meanProbB": 0.023408, "headB_baseRate": 0.015228, "canLaunchRows": 1182, "positives": 18},
    "cooperative": {"headB_auprcMultiple": 3.439, "headB_rocAuc": 0.740, "headB_ece15bin": 0.010945,
                    "headB_meanProbB": 0.028437, "headB_baseRate": 0.017493, "canLaunchRows": 343, "positives": 6},
    "pvp": {"headB_auprcMultiple": 5.342, "headB_rocAuc": 0.810, "headB_ece15bin": 0.014731,
            "headB_meanProbB": 0.025005, "headB_baseRate": 0.010274, "canLaunchRows": 292, "positives": 3},
    "event": {"headB_auprcMultiple": 1.357, "headB_rocAuc": 0.553, "headB_ece15bin": 0.027335,
              "headB_meanProbB": 0.035606, "headB_baseRate": 0.008271, "canLaunchRows": 1209, "positives": 10},
}


def _open_text(path: Path):
    import gzip
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def collect_indist_seen(paths: list, classes: dict) -> dict:
    maps, modes, versions, shipids, class_names = set(), set(), set(), set(), set()
    rows = 0
    for path in paths:
        with _open_text(Path(path)) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                rows += 1
                m = row.get("mapName")
                if m is not None:
                    maps.add(str(m))
                modes.add(str(row.get("gameMode")))
                versions.add(str(row.get("replayVersion")))
                sid = row.get("shipId")
                if sid is not None:
                    sid_i = int(sid)
                    shipids.add(sid_i)
                    class_names.add(class_of(sid_i, classes))
    return {"maps": maps, "modes": modes, "versions": versions, "shipIds": shipids,
            "classes": class_names, "rows": rows}


def attach_external(dataset_path: Path, preds: dict, classes: dict) -> dict:
    n = len(preds["probB"])
    modes = np.empty(n, dtype=object)
    maps = np.empty(n, dtype=object)
    versions = np.empty(n, dtype=object)
    clss = np.empty(n, dtype=object)
    dates = np.empty(n, dtype=object)
    i = 0
    with Path(dataset_path).open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            if i >= n:
                raise SystemExit("[e26ag] dataset has more rows than predictions")
            r = json.loads(line)
            if str(r.get("replayId")) != str(preds["replayId"][i]):
                raise SystemExit("[e26ag] replayId mismatch at row " + str(i))
            if abs(float(r.get("t", -1)) - float(preds["t"][i])) > 1e-3:
                raise SystemExit("[e26ag] t mismatch at row " + str(i))
            if int(r.get("shipId", -1)) != int(preds["shipId"][i]):
                raise SystemExit("[e26ag] shipId mismatch at row " + str(i))
            sid = int(r.get("shipId", -1))
            modes[i] = str(r.get("gameMode"))
            maps[i] = str(r.get("mapName"))
            versions[i] = str(r.get("replayVersion"))
            clss[i] = class_of(sid if sid >= 0 else None, classes)
            dates[i] = str(r.get("replayId"))[:8]
            i += 1
    if i != n:
        raise SystemExit("[e26ag] dataset rows " + str(i) + " != predictions " + str(n))
    preds.update({"gameMode": modes, "mapName": maps, "replayVersion": versions,
                  "shipClass": clss, "date": dates})
    return preds


def load_predictions(path: Path) -> dict:
    z = np.load(path, allow_pickle=True)
    need = ("probA", "probB", "probC", "labelA", "labelB", "fired", "hits", "replayId", "t", "shipId")
    missing = [k for k in need if k not in z.files]
    if missing:
        raise SystemExit("[e26ag] predictions npz missing: " + ", ".join(missing))
    return {k: z[k] for k in z.files}


def headb_stats(preds: dict, mask) -> dict:
    mask = np.asarray(mask, dtype=bool)
    can = mask & (preds["labelA"] == 1.0) & np.isfinite(preds["labelB"])
    y = np.nan_to_num(preds["labelB"][can], nan=0.0)
    p = preds["probB"][can]
    base = float(y.mean()) if len(y) else None
    out = {"canLaunchRows": int(can.sum()), "positives": int(y.sum()), "baseRate": base,
           "meanProbB": (float(p.mean()) if len(p) else None)}
    if 0 < int(y.sum()) < len(y):
        m = head_b_metrics(y, p)
        out.update({
            "auprc": m.get("auprc"),
            "auprcMultiple": (m.get("auprc") / base if m.get("auprc") is not None and base else None),
            "topDecileLift": (m.get("topDecile") or {}).get("lift"),
            "rocAuc": m.get("roc_auc"), "ece15bin": m.get("ece_15bin"),
            "brier": m.get("brier"), "logloss": m.get("logloss"),
            "meanMinusBase": (float(p.mean()) - base) if base else None,
        })
    else:
        out["note"] = "single-class or no positives: discrimination metrics undefined"
    return out


def outcome_stats(preds: dict, mask) -> dict:
    mask = np.asarray(mask, dtype=bool)
    fired = preds["fired"]
    hits = preds["hits"]
    launched = mask & (preds["labelB"] == 1.0) & (fired >= 1)
    f = fired[launched]
    h = hits[launched]
    out = {"launchedRows": int(launched.sum()), "firedFish": int(f.sum()), "hits": int(h.sum()),
           "baseHitRate": (float(h.sum() / f.sum()) if f.sum() > 0 else None)}
    if (int(launched.sum()) >= MIN_OUTCOME_LAUNCHED and int(f.sum()) >= MIN_OUTCOME_FIRED
            and int(h.sum()) >= MIN_OUTCOME_HITS):
        res = holdout_outcome_metrics(preds["probC"][launched], f, h, preds["replayId"][launched],
                                      reps=1000, seed=0)
        out.update({"topDecileLift": res.get("topDecileLift"),
                    "spearmanDecile": res.get("spearmanDecile"),
                    "lift95": (res.get("bootstrap") or {}).get("lift95"),
                    "implementation": (res.get("bootstrap") or {}).get("implementation")})
    else:
        out["note"] = ("outcome metrics skipped: need launched>=" + str(MIN_OUTCOME_LAUNCHED)
                       + ", fired>=" + str(MIN_OUTCOME_FIRED) + ", hits>=" + str(MIN_OUTCOME_HITS))
    return out


def summarize(preds: dict, masks: dict) -> dict:
    out = {}
    for name, mask in masks.items():
        out[name] = {"rows": int(np.asarray(mask).sum()),
                     "headB": headb_stats(preds, mask), "headC": outcome_stats(preds, mask)}
    return out


def subset_by(preds: dict, keys: list) -> dict:
    out = {}
    for key in keys:
        vals = preds[key]
        for v in sorted(set(str(x) for x in vals)):
            m = np.array([str(x) == v for x in vals], dtype=bool)
            out[key + "=" + v] = m
    return out


def build_report(preds: dict, seen: dict) -> dict:
    n = len(preds["probB"])
    cls_seen = preds["shipClass"] != "unknown"
    map_seen = np.array([str(m) in seen["maps"] for m in preds["mapName"]], dtype=bool)
    mode_seen = np.array([str(m) in seen["modes"] for m in preds["gameMode"]], dtype=bool)
    ver_seen = np.array([str(v) in seen["versions"] for v in preds["replayVersion"]], dtype=bool)
    matched_mapclass = cls_seen & map_seen
    matched_strict = matched_mapclass & mode_seen & ver_seen
    unmatched = ~matched_mapclass
    masks = {
        "full": np.ones(n, dtype=bool),
        "matched_mapclass": matched_mapclass,
        "matched_strict": matched_strict,
        "unmatched_novelty": unmatched,
        "knownclass_unseenmap": cls_seen & ~map_seen,
        "unknownclass": ~cls_seen,
        "seenmap_only": map_seen,
    }
    rep = {
        "provenance": {
            "externalRows": n,
            "externalReplays": int(len(set(str(x) for x in preds["replayId"]))),
            "indistRowsStreamed": int(seen["rows"]),
            "seenMaps": sorted(seen["maps"]),
            "seenModes": sorted(seen["modes"]),
            "seenVersions": sorted(seen["versions"]),
            "seenClasses": sorted(seen["classes"]),
            "seenShipIds": len(seen["shipIds"]),
            "externalModes": dict(sorted(Counter(str(x) for x in preds["gameMode"]).items())),
            "externalVersions": dict(sorted(Counter(str(x) for x in preds["replayVersion"]).items())),
        },
        "subsets": summarize(preds, masks),
        "byMode": {},
        "byVersionMatched": {},
        "strictSubsets": subset_by(preds, ["gameMode"]),
        "reference": {"externalFull": EXTERNAL_FULL, "inDistT4": IN_DIST_T4, "externalModes": EXTERNAL_MODE_REF},
        "matchedNovelty": {
            "knownClassRows": int(cls_seen.sum()), "unknownClassRows": int((~cls_seen).sum()),
            "seenMapRows": int(map_seen.sum()), "unseenMapRows": int((~map_seen).sum()),
            "matchedMapclassRows": int(matched_mapclass.sum()),
            "matchedStrictRows": int(matched_strict.sum()),
            "unmatchedRows": int(unmatched.sum()),
        },
    }
    for g in sorted(set(str(x) for x in preds["gameMode"])):
        mask = np.array([str(x) == g for x in preds["gameMode"]], dtype=bool)
        rep["byMode"][g] = {"rows": int(mask.sum()),
                            "headB": headb_stats(preds, mask), "headC": outcome_stats(preds, mask)}
    for v in sorted(set(str(x) for x in preds["replayVersion"])):
        mask = np.array([str(x) == v for x in preds["replayVersion"]], dtype=bool)
        rep["byVersionMatched"][v] = {"rows": int(mask.sum()),
                                      "headB": headb_stats(preds, mask), "headC": outcome_stats(preds, mask)}
    rep["matchedByMode"] = {}
    for g in sorted(set(str(x) for x in preds["gameMode"])):
        mask = matched_mapclass & np.array([str(x) == g for x in preds["gameMode"]], dtype=bool)
        rep["matchedByMode"][g] = {"rows": int(mask.sum()),
                                   "headB": headb_stats(preds, mask), "headC": outcome_stats(preds, mask)}
    rep["matchedByVersion"] = {}
    for v in sorted(set(str(x) for x in preds["replayVersion"])):
        mask = matched_mapclass & np.array([str(x) == v for x in preds["replayVersion"]], dtype=bool)
        rep["matchedByVersion"][v] = {"rows": int(mask.sum()),
                                      "headB": headb_stats(preds, mask), "headC": outcome_stats(preds, mask)}
    # strict matched vs novelty-only magnitudes
    return rep


def sanitize(o):
    """Recursively convert numpy scalars/arrays to plain JSON values."""
    if isinstance(o, dict):
        return {k: sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [sanitize(v) for v in o]
    if isinstance(o, np.ndarray):
        return [sanitize(v) for v in o.tolist()]
    if isinstance(o, np.generic):
        return sanitize(o.item())
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def _fmt(v, d=4):
    if v is None:
        return "-"
    if isinstance(v, float):
        return str(round(v, d))
    return str(v)


def write_markdown(rep: dict, path: Path):
    lines = ["# E26e-ag matched-domain external subset", ""]
    p = rep["provenance"]
    lines.append("external " + str(p["externalRows"]) + " rows / " + str(p["externalReplays"]) + " replays; in-dist " + str(p["indistRowsStreamed"]) + " rows streamed")
    lines.append("")
    lines.append("seen maps " + str(len(p["seenMaps"])) + " | seen modes " + json.dumps(p["seenModes"]) + " | seen versions " + json.dumps(p["seenVersions"]) + " | seen classes " + json.dumps(p["seenClasses"]))
    lines.append("")
    lines.append("## Subsets: headB and headC")
    lines.append("")
    lines.append("| subset | rows | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) | launched/fired/hits | headC lift |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for name, s in rep["subsets"].items():
        hb, hc = s["headB"], s["headC"]
        lines.append("| " + name + " | " + str(s["rows"]) + " | " + str(hb["canLaunchRows"]) + " (" + str(hb["positives"]) + ") | "
                     + _fmt(hb.get("baseRate")) + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | "
                     + _fmt(hb.get("rocAuc")) + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " | "
                     + str(hc["launchedRows"]) + "/" + str(hc["firedFish"]) + "/" + str(hc["hits"]) + " | " + _fmt(hc.get("topDecileLift")) + " |")
    lines.append("")
    lines.append("## By mode (full external)")
    lines.append("")
    lines.append("| mode | rows | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) | launched/fired/hits | headC lift |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for name, s in rep["byMode"].items():
        hb, hc = s["headB"], s["headC"]
        lines.append("| " + name + " | " + str(s["rows"]) + " | " + str(hb["canLaunchRows"]) + " (" + str(hb["positives"]) + ") | "
                     + _fmt(hb.get("baseRate")) + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | "
                     + _fmt(hb.get("rocAuc")) + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " | "
                     + str(hc["launchedRows"]) + "/" + str(hc["firedFish"]) + "/" + str(hc["hits"]) + " | " + _fmt(hc.get("topDecileLift")) + " |")
    lines.append("")
    lines.append("## Matched subset by mode")
    lines.append("")
    lines.append("| mode | rows | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) | launched/fired/hits |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for name, s in rep["matchedByMode"].items():
        hb, hc = s["headB"], s["headC"]
        lines.append("| " + name + " | " + str(s["rows"]) + " | " + str(hb["canLaunchRows"]) + " (" + str(hb["positives"]) + ") | "
                     + _fmt(hb.get("baseRate")) + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | "
                     + _fmt(hb.get("rocAuc")) + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " | "
                     + str(hc["launchedRows"]) + "/" + str(hc["firedFish"]) + "/" + str(hc["hits"]) + " |")
    lines.append("")
    lines.append("## Matched subset by version")
    lines.append("")
    lines.append("| version | rows | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for name, s in rep["matchedByVersion"].items():
        hb = s["headB"]
        lines.append("| " + name + " | " + str(s["rows"]) + " | " + str(hb["canLaunchRows"]) + " (" + str(hb["positives"]) + ") | "
                     + _fmt(hb.get("baseRate")) + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | "
                     + _fmt(hb.get("rocAuc")) + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " |")
    lines.append("")
    lines.append("## By version")
    lines.append("")
    lines.append("| version | rows | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) | launched/fired/hits |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for name, s in rep["byVersionMatched"].items():
        hb, hc = s["headB"], s["headC"]
        lines.append("| " + name + " | " + str(s["rows"]) + " | " + str(hb["canLaunchRows"]) + " (" + str(hb["positives"]) + ") | "
                     + _fmt(hb.get("baseRate")) + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | "
                     + _fmt(hb.get("rocAuc")) + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " | "
                     + str(hc["launchedRows"]) + "/" + str(hc["firedFish"]) + "/" + str(hc["hits"]) + " |")
    lines.append("")
    lines.append("## Novelty decomposition")
    lines.append("")
    lines.append(json.dumps(rep["matchedNovelty"], indent=1))
    lines.append("")
    lines.append("Reference: external full " + json.dumps(EXTERNAL_FULL) + "; in-dist T4 " + json.dumps(IN_DIST_T4))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    import tempfile
    root = Path(tempfile.mkdtemp(prefix="e26ag-selftest-"))
    ds = root / "external.jsonl"
    rows = [
        {"replayId": "r1", "t": 1.0, "shipId": 11, "gameMode": "pvp", "mapName": "m1", "replayVersion": "v1"},
        {"replayId": "r1", "t": 3.0, "shipId": 11, "gameMode": "pvp", "mapName": "m1", "replayVersion": "v1"},
        {"replayId": "r2", "t": 1.0, "shipId": 22, "gameMode": "event", "mapName": "m2", "replayVersion": "v2"},
    ]
    with ds.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + chr(10))
    preds = {
        "probA": np.array([0.9, 0.8, 0.7]), "probB": np.array([0.9, 0.2, 0.8]), "probC": np.array([0.8, 0.3, 0.6]),
        "labelA": np.array([1.0, 1.0, 1.0]), "labelB": np.array([1.0, 0.0, 1.0]),
        "fired": np.array([2, 0, 1]), "hits": np.array([1, 0, 1]),
        "replayId": np.array(["r1", "r1", "r2"], dtype=object),
        "t": np.array([1.0, 3.0, 1.0]), "shipId": np.array([11, 11, 22]),
    }
    classes = {11: "Destroyer", 22: "Cruiser"}
    p = attach_external(ds, preds, classes)
    seen = {"maps": {"m1"}, "modes": {"pvp", "pve"}, "versions": {"v1"}, "classes": {"Destroyer", "Cruiser"},
            "shipIds": {11}, "rows": 10}
    rep = build_report(p, seen)
    assert rep["matchedNovelty"]["matchedMapclassRows"] == 2
    assert rep["matchedNovelty"]["matchedStrictRows"] == 2
    assert rep["matchedNovelty"]["unknownClassRows"] == 0
    assert rep["subsets"]["matched_mapclass"]["headB"]["canLaunchRows"] == 2
    assert rep["subsets"]["full"]["rows"] == 3
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-ag matched-domain external subset")
    ap.add_argument("--predictions", default="")
    ap.add_argument("--external-dataset", default="")
    ap.add_argument("--indist", nargs="+", default=[])
    ap.add_argument("--ships", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("predictions", "external_dataset", "indist", "ships", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26ag] missing arguments: " + ", ".join(missing))
    classes, _ = load_ship_classes(Path(args.ships))
    print("[e26ag] streaming in-dist corpus for seen vocabularies...", flush=True)
    seen = collect_indist_seen(args.indist, classes)
    print("[e26ag] seen maps " + str(len(seen["maps"])) + " modes " + str(sorted(seen["modes"]))
          + " versions " + str(sorted(seen["versions"])), flush=True)
    preds = load_predictions(Path(args.predictions))
    preds = attach_external(Path(args.external_dataset), preds, classes)
    rep = build_report(preds, seen)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_lineage": "E26e-ag matched-domain external subset (descriptive; no retraining)", "report": rep}
    (out_dir / "external_matched.json").write_text(
        json.dumps(sanitize(payload), indent=1, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    write_markdown(rep, out_dir / "external_matched_report.md")
    print("[e26ag] subsets: " + json.dumps({k: v["rows"] for k, v in rep["subsets"].items()}))
    for name in ("full", "matched_mapclass", "matched_strict", "unmatched_novelty"):
        s = rep["subsets"][name]
        hb, hc = s["headB"], s["headC"]
        print("[e26ag] " + name + ": can " + str(hb["canLaunchRows"]) + "/pos " + str(hb["positives"])
              + " x" + str(None if hb.get("auprcMultiple") is None else round(hb["auprcMultiple"], 3))
              + " top " + str(hb.get("topDecileLift")) + " AUC " + str(hb.get("rocAuc"))
              + " ECE " + str(hb.get("ece15bin")) + " meanProb " + str(hb.get("meanProbB"))
              + " | launched/fired/hits " + str(hc["launchedRows"]) + "/" + str(hc["firedFish"]) + "/" + str(hc["hits"])
              + " lift " + str(hc.get("topDecileLift")))
    print("[e26ag] summary -> " + str(out_dir / "external_matched.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
