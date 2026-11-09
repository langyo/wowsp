#!/usr/bin/env python3
"""E26e-ad: in-distribution event/DD baseline (E26e-g OOF) vs the external E26e-ac result.

Streams the 4 full-corpus shards (rowIndex order) for gameMode/mapName, the r120 outcome
sidecars for fired/hits, and the E26e-g OOF for probA/B/C + labels, then reports headB and
headC by gameMode / shipClass / mode x class. Descriptive only (no retraining).
"""
from __future__ import annotations

import argparse
import gzip
import json
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np

import sys
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from train_torpedo_model import head_b_metrics, holdout_outcome_metrics  # noqa: E402

MIN_OUTCOME_LAUNCHED = 200
MIN_OUTCOME_FIRED = 500
MIN_OUTCOME_HITS = 20
# Exploratory secondary rule (added before the final run, after seeing the in-dist event cell has
# 118 launched / 358 fired / 59 hits): small-but-non-degenerate cells get a labelled lift.
MIN_SECONDARY_LAUNCHED = 100
MIN_SECONDARY_FIRED = 250
MIN_SECONDARY_HITS = 25
EXTERNAL = {
    "event": {"canLaunchRows": 1209, "canLaunchPositives": 10, "baseRate": 0.008271, "meanProbB": 0.035606,
              "ece15bin": 0.027335, "rocAuc": 0.552711, "topDecileLift": 0.0, "auprcMultiple": 1.356833,
              "launchedRows": 10, "firedFish": 29, "hits": 0},
    "Destroyer": {"canLaunchRows": 1006, "canLaunchPositives": 7, "baseRate": 0.006958, "meanProbB": 0.032248,
                  "ece15bin": 0.025290, "rocAuc": 0.622623, "topDecileLift": 1.422914, "auprcMultiple": 1.564995,
                  "launchedRows": 7, "firedFish": 27, "hits": 5},
    "event|Destroyer": {"canLaunchRows": 425, "canLaunchPositives": 2, "baseRate": 0.004706,
                        "meanProbB": 0.040085, "ece15bin": 0.035379, "rocAuc": 0.348700,
                        "topDecileLift": 0.0, "auprcMultiple": 1.244902, "launchedRows": 2, "firedFish": 10, "hits": 0},
}


def _open_text(path: Path):
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def load_oof(path: Path) -> dict:
    z = np.load(path, allow_pickle=False)
    need = ("probB", "probC", "labelA", "labelB", "rowIndex", "shipId", "t", "classCode", "regionCode", "groupCode")
    missing = [k for k in need if k not in z.files]
    if missing:
        raise SystemExit("[e26ad] OOF npz missing: " + ", ".join(missing))
    return {
        "probB": z["probB"].astype(np.float64), "probC": z["probC"].astype(np.float64),
        "labelA": z["labelA"].astype(np.float64), "labelB": z["labelB"].astype(np.float64),
        "rowIndex": z["rowIndex"].astype(np.int64), "shipId": z["shipId"].astype(np.int64),
        "t": z["t"].astype(np.float64), "classCode": z["classCode"].astype(np.int64),
        "classNames": [str(x) for x in z["classNames"].tolist()],
        "regionCode": z["regionCode"].astype(np.int64),
        "regionNames": [str(x) for x in z["regionNames"].tolist()],
        "groupCode": z["groupCode"].astype(np.int64),
    }


def attach_dataset_modes(oof: dict, data_paths: list) -> tuple:
    n = len(oof["shipId"])
    modes = np.empty(n, dtype=object)
    maps = np.empty(n, dtype=object)
    i = 0
    for path in data_paths:
        with _open_text(Path(path)) as f:
            for line in f:
                if not line.strip():
                    continue
                if i >= n:
                    raise SystemExit("[e26ad] dataset has more rows than the OOF")
                r = json.loads(line)
                if int(r.get("shipId", -1)) != int(oof["shipId"][i]):
                    raise SystemExit("[e26ad] shipId mismatch at row " + str(i))
                if abs(float(r.get("t", -1)) - float(oof["t"][i])) > 1e-3:
                    raise SystemExit("[e26ad] t mismatch at row " + str(i))
                modes[i] = str(r.get("gameMode"))
                maps[i] = str(r.get("mapName"))
                i += 1
    if i != n:
        raise SystemExit("[e26ad] dataset rows " + str(i) + " != OOF rows " + str(n))
    return modes, maps


OUTCOME_ALIASES_FIRED = ("torpFiredFish", "torp_fired_fish", "firedFish")
OUTCOME_ALIASES_HITS = ("torpHits", "torp_hits", "hits")


def _pick(rec: dict, names):
    for k in names:
        if k in rec:
            return rec[k]
    return None


def stream_outcomes(paths: list, n: int) -> tuple:
    fired = np.zeros(n, dtype=np.int64)
    hits = np.zeros(n, dtype=np.int64)
    i = 0
    for path in paths:
        with _open_text(Path(path)) as f:
            for line in f:
                if not line.strip():
                    continue
                if i >= n:
                    raise SystemExit("[e26ad] outcome has more rows than the OOF")
                rec = json.loads(line)
                fired[i] = int(_pick(rec, OUTCOME_ALIASES_FIRED) or 0)
                hits[i] = int(_pick(rec, OUTCOME_ALIASES_HITS) or 0)
                i += 1
    if i != n:
        raise SystemExit("[e26ad] outcome rows " + str(i) + " != OOF rows " + str(n))
    return fired, hits


def can_launch(oof: dict, mask=None):
    m = (oof["labelA"] == 1.0) & np.isfinite(oof["labelB"])
    return m if mask is None else (m & np.asarray(mask, dtype=bool))


def launched(oof: dict, fired: np.ndarray, mask=None):
    m = (oof["labelB"] == 1.0) & (fired >= 1)
    return m if mask is None else (m & np.asarray(mask, dtype=bool))


def headb_stats(oof: dict, mask) -> dict:
    can = can_launch(oof, mask)
    y = np.nan_to_num(oof["labelB"][can], nan=0.0)
    p = oof["probB"][can]
    base = float(y.mean()) if len(y) else None
    out = {"rows": int(can.sum()), "positives": int(y.sum()), "baseRate": base}
    if 0 < int(y.sum()) < len(y):
        m = head_b_metrics(y, p)
        out.update({
            "auprc": m.get("auprc"),
            "auprcMultiple": (m.get("auprc") / base if m.get("auprc") is not None and base else None),
            "topDecileLift": (m.get("topDecile") or {}).get("lift"),
            "rocAuc": m.get("roc_auc"), "ece15bin": m.get("ece_15bin"), "meanProbB": float(p.mean()),
            "meanMinusBase": (float(p.mean()) - base) if base else None,
            "probB_p10": float(np.quantile(p, 0.1)), "probB_p50": float(np.quantile(p, 0.5)),
            "probB_p90": float(np.quantile(p, 0.9)),
        })
    else:
        out.update({"meanProbB": float(p.mean()) if len(p) else None,
                    "note": "single-class or no positives: discrimination metrics undefined"})
    return out


def outcome_stats(oof: dict, fired: np.ndarray, hits: np.ndarray, mask) -> dict:
    m = launched(oof, fired, mask)
    rows = int(m.sum())
    f = fired[m]
    h = hits[m]
    out = {"launchedRows": rows, "firedFish": int(f.sum()), "hits": int(h.sum()),
           "baseHitRate": (float(h.sum() / f.sum()) if f.sum() > 0 else None)}
    main_ok = rows >= MIN_OUTCOME_LAUNCHED and f.sum() >= MIN_OUTCOME_FIRED and h.sum() >= MIN_OUTCOME_HITS
    secondary_ok = rows >= MIN_SECONDARY_LAUNCHED and f.sum() >= MIN_SECONDARY_FIRED and h.sum() >= MIN_SECONDARY_HITS
    if main_ok or secondary_ok:
        res = holdout_outcome_metrics(oof["probC"][m], f, h, oof["groupCode"][m], reps=1000, seed=0)
        out.update({"topDecileLift": res.get("topDecileLift"), "spearmanDecile": res.get("spearmanDecile"),
                    "lift95": (res.get("bootstrap") or {}).get("lift95"),
                    "implementation": (res.get("bootstrap") or {}).get("implementation"),
                    "secondaryRelaxed": bool(not main_ok)})
    else:
        out["note"] = ("outcome metrics skipped: need launched>=" + str(MIN_OUTCOME_LAUNCHED)
                       + ", fired>=" + str(MIN_OUTCOME_FIRED) + ", hits>=" + str(MIN_OUTCOME_HITS)
                       + " (or secondary launched>=" + str(MIN_SECONDARY_LAUNCHED) + ", fired>="
                       + str(MIN_SECONDARY_FIRED) + ", hits>=" + str(MIN_SECONDARY_HITS) + ")")
    return out


def summarize(oof: dict, fired: np.ndarray, hits: np.ndarray, groups, name: str) -> dict:
    groups = np.asarray(groups, dtype=object)
    out = {}
    for g in sorted(set(str(x) for x in groups)):
        mask = np.array([str(x) == g for x in groups], dtype=bool)
        if not mask.any():
            continue
        out[g] = {"headB": headb_stats(oof, mask), "headC": outcome_stats(oof, fired, hits, mask)}
    return out


def build_report(oof: dict, modes, maps, fired, hits) -> dict:
    classes = np.array([oof["classNames"][int(c)] if 0 <= int(c) < len(oof["classNames"]) else "unknown"
                        for c in oof["classCode"]], dtype=object)
    regions = np.array([oof["regionNames"][int(c)] if 0 <= int(c) < len(oof["regionNames"]) else "unknown"
                        for c in oof["regionCode"]], dtype=object)
    mode_class = np.array([str(m) + "|" + str(c) for m, c in zip(modes, classes)], dtype=object)
    overall_mask = np.ones(len(modes), dtype=bool)
    report = {
        "provenance": {
            "rows": int(len(modes)),
            "replays": int(len(set(int(g) for g in oof["groupCode"]))),
            "modeRows": dict(sorted(Counter(str(x) for x in modes).items())),
            "classRows": dict(sorted(Counter(str(x) for x in classes).items())),
            "regionRows": dict(sorted(Counter(str(x) for x in regions).items())),
            "eventMaps": dict(Counter(str(m) for m in maps[np.array([str(x) == "event" for x in modes])]).most_common(10)),
        },
        "overall": {"headB": headb_stats(oof, overall_mask), "headC": outcome_stats(oof, fired, hits, overall_mask)},
        "byMode": summarize(oof, fired, hits, modes, "mode"),
        "byClass": summarize(oof, fired, hits, classes, "class"),
        "byModeClass": summarize(oof, fired, hits, mode_class, "mode|class"),
        "external": EXTERNAL,
    }
    return report


def _fmt(v, d=4):
    if v is None:
        return "-"
    if isinstance(v, float):
        return str(round(v, d))
    return str(v)


def write_markdown(report: dict, path: Path):
    lines = ["# E26e-ad in-distribution event/DD baseline vs external", ""]
    p = report["provenance"]
    lines.append("rows " + str(p["rows"]) + " / replays " + str(p["replays"])
                 + " | modes " + json.dumps(p["modeRows"]) + " | classes " + json.dumps(p["classRows"]))
    lines.append("")
    lines.append("event maps (in-dist): " + json.dumps(p["eventMaps"]))
    lines.append("")
    lines.append("## Overall / by mode")
    lines.append("")
    lines.append("| stratum | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) | launched/fired/hits | lift | rho |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    def emit(label, hb, hc):
        lines.append("| " + label + " | " + str(hb["rows"]) + " (" + str(hb["positives"]) + ") | " + _fmt(hb.get("baseRate"))
                     + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | " + _fmt(hb.get("rocAuc"))
                     + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " | "
                     + str(hc["launchedRows"]) + "/" + str(hc["firedFish"]) + "/" + str(hc["hits"]) + " | "
                     + _fmt(hc.get("topDecileLift")) + ("*" if hc.get("secondaryRelaxed") else "") + " | "
                     + _fmt(hc.get("spearmanDecile")) + " |")
    emit("overall", report["overall"]["headB"], report["overall"]["headC"])
    for g, v in report["byMode"].items():
        emit("mode=" + g, v["headB"], v["headC"])
    lines.append("")
    lines.append("## By class / mode x class (selected)")
    lines.append("")
    lines.append("| stratum | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) | launched/fired/hits | lift |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for g, v in report["byClass"].items():
        hb, hc = v["headB"], v["headC"]
        lines.append("| class=" + g + " | " + str(hb["rows"]) + " (" + str(hb["positives"]) + ") | " + _fmt(hb.get("baseRate"))
                     + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | " + _fmt(hb.get("rocAuc"))
                     + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " | "
                     + str(hc["launchedRows"]) + "/" + str(hc["firedFish"]) + "/" + str(hc["hits"]) + " | "
                     + _fmt(hc.get("topDecileLift")) + ("*" if hc.get("secondaryRelaxed") else "") + " |")
    for g in sorted(report["byModeClass"]):
        if "|" not in g:
            continue
        mode, cls = g.split("|", 1)
        if mode not in ("event", "brawl", "pvp", "pve", "cooperative") and cls != "Destroyer":
            continue
        hb, hc = report["byModeClass"][g]["headB"], report["byModeClass"][g]["headC"]
        lines.append("| " + g + " | " + str(hb["rows"]) + " (" + str(hb["positives"]) + ") | " + _fmt(hb.get("baseRate"))
                     + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | " + _fmt(hb.get("rocAuc"))
                     + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " | "
                     + str(hc["launchedRows"]) + "/" + str(hc["firedFish"]) + "/" + str(hc["hits"]) + " | "
                     + _fmt(hc.get("topDecileLift")) + " |")
    lines.append("")
    lines.append("* = exploratory secondary threshold (launched>=100, fired>=250, hits>=25); not the preregistered main rule.")
    lines.append("")
    lines.append("## External (E26e-ac) reference")
    lines.append("")
    lines.append("| stratum | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) | launched/fired/hits |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for g, v in EXTERNAL.items():
        lines.append("| " + g + " | " + str(v["canLaunchRows"]) + " (" + str(v["canLaunchPositives"]) + ") | " + _fmt(v["baseRate"])
                     + " | " + _fmt(v["meanProbB"]) + " | " + _fmt(v["ece15bin"]) + " | " + _fmt(v["rocAuc"])
                     + " | " + _fmt(v["topDecileLift"]) + " | " + _fmt(v["auprcMultiple"], 3) + " | "
                     + str(v["launchedRows"]) + "/" + str(v["firedFish"]) + "/" + str(v["hits"]) + " |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    root = Path(tempfile.mkdtemp(prefix="e26ad-selftest-"))
    ds = root / "dataset.jsonl"
    oc = root / "outcome.jsonl"
    rows = [
        {"replayId": "r1", "t": 1.0, "shipId": 11, "gameMode": "event", "mapName": "m1",
         "labelACanLaunch": True, "labelBLaunched": True},
        {"replayId": "r1", "t": 3.0, "shipId": 11, "gameMode": "event", "mapName": "m1",
         "labelACanLaunch": True, "labelBLaunched": False},
        {"replayId": "r2", "t": 1.0, "shipId": 22, "gameMode": "pvp", "mapName": "m2",
         "labelACanLaunch": True, "labelBLaunched": True},
    ]
    with ds.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + chr(10))
    with oc.open("w", encoding="utf-8") as f:
        for i in range(3):
            f.write(json.dumps({"torpFiredFish": 2, "torpHits": 1 if i != 1 else 0}) + chr(10))
    oof = {
        "probB": np.array([0.9, 0.8, 0.7]), "probC": np.array([0.6, 0.5, 0.4]),
        "labelA": np.array([1.0, 1.0, 1.0]), "labelB": np.array([1.0, 0.0, 1.0]),
        "rowIndex": np.arange(3), "shipId": np.array([11, 11, 22]), "t": np.array([1.0, 3.0, 1.0]),
        "classCode": np.array([2, 2, 1]), "classNames": ["Battleship", "Cruiser", "Destroyer"],
        "regionCode": np.array([0, 0, 1]), "regionNames": ["apac", "eu"],
        "groupCode": np.array([0, 0, 1]),
    }
    modes, maps = attach_dataset_modes(oof, [ds])
    assert list(modes) == ["event", "event", "pvp"], modes
    fired, hits = stream_outcomes([oc], 3)
    assert list(fired) == [2, 2, 2] and list(hits) == [1, 0, 1]
    report = build_report(oof, modes, maps, fired, hits)
    assert report["provenance"]["modeRows"]["event"] == 2
    assert report["byMode"]["event"]["headB"]["positives"] == 1
    assert report["byMode"]["event"]["headC"]["launchedRows"] == 1
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-ad in-distribution mode/class baseline")
    ap.add_argument("--oof", default="")
    ap.add_argument("--data", nargs="+", default=[])
    ap.add_argument("--outcome", nargs="+", default=[])
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("oof", "data", "outcome", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26ad] missing arguments: " + ", ".join(missing))
    oof = load_oof(Path(args.oof))
    print("[e26ad] OOF rows " + format(len(oof["shipId"]), ",") + "; streaming shards for gameMode/mapName...", flush=True)
    modes, maps = attach_dataset_modes(oof, args.data)
    print("[e26ad] streaming r120 outcome sidecars...", flush=True)
    fired, hits = stream_outcomes(args.outcome, len(oof["shipId"]))
    report = build_report(oof, modes, maps, fired, hits)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_lineage": "E26e-ad in-distribution event/DD baseline vs external E26e-ac", "report": report}
    (out_dir / "indist_mode_class.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    write_markdown(report, out_dir / "indist_mode_class_report.md")
    print("[e26ad] modes " + json.dumps(report["provenance"]["modeRows"]))
    for g in ("event", "pvp", "brawl", "pve", "cooperative"):
        if g in report["byMode"]:
            v = report["byMode"][g]
            print("[e26ad] mode=" + g + " " + json.dumps(v["headB"]) + " " + json.dumps(v["headC"]))
    for g in ("Destroyer", "Cruiser", "Battleship", "Submarine"):
        if g in report["byClass"]:
            v = report["byClass"][g]
            print("[e26ad] class=" + g + " " + json.dumps(v["headB"]) + " " + json.dumps(v["headC"]))
    print("[e26ad] summary -> " + str(out_dir / "indist_mode_class.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
