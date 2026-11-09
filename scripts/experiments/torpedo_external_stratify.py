#!/usr/bin/env python3
"""E26e-aa: stratified diagnosis of the external T4 holdout (mode/map/class/version/date).

Reads:
  --predictions  eval_predictions_external.npz written by train_torpedo_model.py --eval-only --eval-predictions-out
  --dataset      external dataset_external.jsonl (row order identical to the predictions)
  --ships        ships_basics.json (shipId -> class)
Outputs (--out-dir):
  external_stratify.json + external_stratify_report.md
No training, no model change.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np

import sys
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from train_torpedo_model import head_b_metrics, holdout_outcome_metrics  # noqa: E402

IN_DIST = {
    "headB_auprc": 0.042126,
    "headB_auprc_multiple": 2.599,
    "headB_topDecileLift": 2.905,
    "headB_roc_auc": 0.7273,
    "headC_outcome_lift": 2.1997,
}
MIN_HEADB_POS = 1
MIN_HEADC_ROW_ROWS = 10
MIN_HEADC_OUT_ROWS = 10
MIN_HEADC_OUT_FIRED = 20
MIN_HEADC_OUT_HITS = 5


def load_ship_classes(path: Path) -> dict[int, str]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    out = {}
    for sid, entry in (raw.get("ships") or {}).items():
        try:
            out[int(sid)] = str(entry.get("type") or "unknown")
        except (TypeError, ValueError):
            continue
    return out


def load_predictions(path: Path) -> dict:
    z = np.load(path, allow_pickle=True)
    need = ("probA", "probB", "probC", "labelA", "labelB", "fired", "hits", "replayId", "t", "shipId")
    missing = [k for k in need if k not in z.files]
    if missing:
        raise SystemExit("[e26aa] predictions npz missing: " + ", ".join(missing))
    out = {k: z[k] for k in z.files}
    out["probB"] = np.asarray(out["probB"], dtype=np.float64)
    out["probC"] = np.asarray(out["probC"], dtype=np.float64)
    out["probA"] = np.asarray(out["probA"], dtype=np.float64)
    out["labelA"] = np.asarray(out["labelA"], dtype=np.float64)
    out["labelB"] = np.asarray(out["labelB"], dtype=np.float64)
    out["fired"] = np.asarray(out["fired"], dtype=np.int64)
    out["hits"] = np.asarray(out["hits"], dtype=np.int64)
    return out


def attach_metadata(preds: dict, dataset_path: Path, class_of: dict) -> dict:
    """Join the per-row dataset metadata; verifies replayId/t/shipId alignment."""
    n = len(preds["probB"])
    modes = np.empty(n, dtype=object)
    maps = np.empty(n, dtype=object)
    classes = np.empty(n, dtype=object)
    versions = np.empty(n, dtype=object)
    dates = np.empty(n, dtype=object)
    i = 0
    with Path(dataset_path).open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            if i >= n:
                raise SystemExit("[e26aa] dataset has more rows than predictions")
            r = json.loads(line)
            if str(r.get("replayId")) != str(preds["replayId"][i]):
                raise SystemExit("[e26aa] replayId mismatch at row " + str(i))
            if abs(float(r.get("t", -1)) - float(preds["t"][i])) > 1e-3:
                raise SystemExit("[e26aa] t mismatch at row " + str(i))
            if int(r.get("shipId", -1)) != int(preds["shipId"][i]):
                raise SystemExit("[e26aa] shipId mismatch at row " + str(i))
            modes[i] = str(r.get("gameMode"))
            maps[i] = str(r.get("mapName"))
            sid = int(r.get("shipId", -1))
            classes[i] = class_of.get(sid, "unknown")
            versions[i] = str(r.get("replayVersion"))
            dates[i] = str(r.get("replayId"))[:8]
            i += 1
    if i != n:
        raise SystemExit("[e26aa] dataset rows " + str(i) + " != predictions " + str(n))
    preds["gameMode"] = modes
    preds["mapName"] = maps
    preds["shipClass"] = classes
    preds["replayVersion"] = versions
    preds["date"] = dates
    preds["isPvp"] = np.array([str(m) == "pvp" for m in modes], dtype=object)
    preds["modeGroup"] = np.array(["pvp" if str(m) == "pvp" else "non-pvp" for m in modes], dtype=object)
    return preds


def group_metrics(preds: dict, mask_rows) -> dict:
    mask_rows = np.asarray(mask_rows, dtype=bool)
    label_a = preds["labelA"]
    label_b = preds["labelB"]
    fired = preds["fired"]
    hits = preds["hits"]
    p_b = preds["probB"]
    p_c = preds["probC"]
    replays = np.asarray([str(x) for x in preds["replayId"]], dtype=object)

    b_mask = mask_rows & (label_a == 1.0) & np.isfinite(label_b)
    n_b = int(b_mask.sum())
    pos = int(np.nansum(label_b[b_mask] == 1.0)) if n_b else 0
    head_b = None
    if n_b > 0 and pos >= MIN_HEADB_POS and pos < n_b:
        head_b = head_b_metrics(label_b[b_mask], p_b[b_mask])
        base = head_b.get("baseRate")
        if base:
            head_b["auprcMultiple"] = float(head_b["auprc"] / base) if head_b.get("auprc") is not None else None
    elif n_b > 0:
        head_b = {"rows": n_b, "positives": pos, "note": "descriptive: fewer than 1 positive or no negatives",
                  "baseRate": (float(pos / n_b) if n_b else None), "auprc": None}

    c_mask = mask_rows & (label_b == 1.0) & (fired >= 1)
    n_c = int(c_mask.sum())
    launched_fired = int(fired[c_mask].sum()) if n_c else 0
    launched_hits = int(hits[c_mask].sum()) if n_c else 0
    head_c_row = None
    if n_c >= MIN_HEADC_ROW_ROWS:
        y = (hits[c_mask] > 0).astype(np.float64)
        if 0 < int(y.sum()) < len(y):
            head_c_row = head_b_metrics(y, p_c[c_mask])
        else:
            head_c_row = {"rows": n_c, "positives": int(y.sum()),
                          "note": "descriptive: single-class headC rows in this stratum"}
    head_c_outcome = None
    if n_c >= MIN_HEADC_OUT_ROWS and launched_fired >= MIN_HEADC_OUT_FIRED and launched_hits >= MIN_HEADC_OUT_HITS:
        head_c_outcome = holdout_outcome_metrics(
            p_c[c_mask], fired[c_mask], hits[c_mask], replays[c_mask],
            reps=1000, seed=0,
        )
    return {
        "rows": int(mask_rows.sum()),
        "canLaunchRows": n_b,
        "canLaunchPositives": pos,
        "launchedRows": n_c,
        "launchedFiredFish": launched_fired,
        "launchedHits": launched_hits,
        "headB": head_b,
        "headC": head_c_row,
        "headCOutcome": head_c_outcome,
        "headCNote": (None if head_c_outcome is not None else
                      "headC outcome descriptive only: launched>=" + str(MIN_HEADC_OUT_ROWS)
                      + ", fired>=" + str(MIN_HEADC_OUT_FIRED) + ", hits>=" + str(MIN_HEADC_OUT_HITS) + " required"),
    }


def summarize_groups(preds: dict, group_arr, name: str, min_rows: int = 0) -> dict:
    out = {}
    for g in sorted(set(str(x) for x in group_arr)):
        mask = np.array([str(x) == g for x in group_arr], dtype=bool)
        if int(mask.sum()) < min_rows:
            continue
        out[g] = group_metrics(preds, mask)
    return out


def build_strata(preds: dict) -> dict:
    all_mask = np.ones(len(preds["probB"]), dtype=bool)
    strata = {
        "overall": group_metrics(preds, all_mask),
        "byMode": summarize_groups(preds, preds["gameMode"], "gameMode"),
        "byModeGroup": summarize_groups(preds, preds["modeGroup"], "modeGroup"),
        "byVersion": summarize_groups(preds, preds["replayVersion"], "replayVersion"),
        "byClass": summarize_groups(preds, preds["shipClass"], "shipClass"),
        "byModeVersion": summarize_groups(preds, np.array(
            [str(m) + "|" + str(v) for m, v in zip(preds["gameMode"], preds["replayVersion"])], dtype=object),
            "mode|version"),
        "byDate": summarize_groups(preds, preds["date"], "date"),
        "byMap": summarize_groups(preds, preds["mapName"], "mapName", min_rows=100),
    }
    # Replay counts per group are part of the descriptive provenance.
    modes = Counter(str(x) for x in preds["gameMode"])
    strata["provenance"] = {
        "rows": int(len(preds["probB"])),
        "replays": int(len(set(str(x) for x in preds["replayId"]))),
        "replayIds": sorted(set(str(x) for x in preds["replayId"])),
        "modeRows": dict(sorted(modes.items())),
        "versionRows": dict(sorted(Counter(str(x) for x in preds["replayVersion"]).items())),
        "classRows": dict(sorted(Counter(str(x) for x in preds["shipClass"]).items())),
        "dateRows": dict(sorted(Counter(str(x) for x in preds["date"]).items())),
        "modeVersionRows": dict(sorted(Counter(str(m) + "|" + str(v) for m, v in
                                                zip(preds["gameMode"], preds["replayVersion"])).items())),
    }
    return strata


def _fmt(v, digits=4):
    if v is None:
        return "-"
    if isinstance(v, float):
        return str(round(v, digits))
    return str(v)


def write_markdown(strata: dict, path: Path):
    lines = ["# E26e-aa external holdout stratified diagnosis", ""]
    lines.append("External 18-replay T4 torp4 evaluation (raw sigmoid probabilities; no retraining).")
    lines.append("")
    prov = strata["provenance"]
    lines.append("rows " + str(prov["rows"]) + " / replays " + str(prov["replays"])
                 + " | modes " + json.dumps(prov["modeRows"])
                 + " | versions " + json.dumps(prov["versionRows"]))
    lines.append("")
    lines.append("## Overall / by mode / mode group")
    lines.append("")
    lines.append("| stratum | rows | canLaunch (pos) | launched | fired | hits | headB AUPRC (mult) | headB top | headB AUC | headC lift | rho | CI |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    def emit(label, g):
        hb = g.get("headB") or {}
        mult = hb.get("auprcMultiple")
        out = g.get("headCOutcome") or {}
        ci = None
        if out:
            ci = (out.get("bootstrap") or {}).get("lift95")
        lines.append("| " + label + " | " + str(g["rows"]) + " | " + str(g["canLaunchRows"]) + " (" + str(g["canLaunchPositives"]) + ") | "
                     + str(g["launchedRows"]) + " | " + str(g["launchedFiredFish"]) + " | " + str(g["launchedHits"]) + " | "
                     + _fmt(hb.get("auprc")) + " (" + _fmt(mult, 3) + ") | " + _fmt((hb.get("topDecile") or {}).get("lift")) + " | "
                     + _fmt(hb.get("roc_auc")) + " | " + _fmt(out.get("topDecileLift")) + " | " + _fmt(out.get("spearmanDecile")) + " | "
                     + ("-" if ci is None else str([round(float(v), 3) for v in ci])) + " |")
    emit("overall", strata["overall"])
    for g, v in strata["byMode"].items():
        emit("mode=" + g, v)
    for g, v in strata["byModeGroup"].items():
        emit("group=" + g, v)
    lines.append("")
    lines.append("## By version / class / map")
    lines.append("")
    lines.append("| stratum | rows | canLaunch (pos) | headB AUPRC (mult) | top | AUC | headC launched/fired/hits |")
    lines.append("|---|---|---|---|---|---|---|")
    def emit2(label, g):
        hb = g.get("headB") or {}
        lines.append("| " + label + " | " + str(g["rows"]) + " | " + str(g["canLaunchRows"]) + " (" + str(g["canLaunchPositives"]) + ") | "
                     + _fmt(hb.get("auprc")) + " (" + _fmt(hb.get("auprcMultiple"), 3) + ") | "
                     + _fmt((hb.get("topDecile") or {}).get("lift")) + " | " + _fmt(hb.get("roc_auc")) + " | "
                     + str(g["launchedRows"]) + "/" + str(g["launchedFiredFish"]) + "/" + str(g["launchedHits"]) + " |")
    for g, v in strata["byVersion"].items():
        emit2("version=" + g, v)
    for g, v in strata["byClass"].items():
        emit2("class=" + g, v)
    for g, v in strata["byMap"].items():
        emit2("map=" + g, v)
    lines.append("")
    lines.append("Reference in-dist T4: headB " + str(IN_DIST["headB_auprc_multiple"]) + "x base / top "
                 + str(IN_DIST["headB_topDecileLift"]) + " / AUC " + str(IN_DIST["headB_roc_auc"])
                 + "; headC outcome " + str(IN_DIST["headC_outcome_lift"]) + ".")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    n = 6
    preds = {
        "probB": np.array([0.9, 0.8, 0.7, 0.6, 0.5, 0.4]),
        "probC": np.array([0.9, 0.8, 0.7, 0.6, 0.5, 0.4]),
        "labelA": np.array([1, 1, 1, 1, 0, 0], dtype=float),
        "labelB": np.array([1, 0, 1, 0, np.nan, np.nan], dtype=float),
        "fired": np.array([2, 0, 1, 0, 0, 0]),
        "hits": np.array([1, 0, 1, 0, 0, 0]),
        "replayId": np.array(["20260101_a", "20260101_a", "20260101_a", "20260102_b", "20260102_b", "20260102_b"], dtype=object),
        "t": np.arange(6, dtype=float), "shipId": np.array([1, 1, 1, 2, 2, 2]),
        "gameMode": np.array(["pvp", "pvp", "pve", "pve", "pve", "event"], dtype=object),
        "mapName": np.array(["m1", "m1", "m2", "m2", "m2", "m2"], dtype=object),
        "shipClass": np.array(["Destroyer", "Destroyer", "Cruiser", "Cruiser", "Cruiser", "Cruiser"], dtype=object),
        "replayVersion": np.array(["v1", "v1", "v1", "v2", "v2", "v2"], dtype=object),
        "date": np.array(["20260101"] * 3 + ["20260102"] * 3, dtype=object),
        "modeGroup": np.array(["pvp", "pvp", "non-pvp", "non-pvp", "non-pvp", "non-pvp"], dtype=object),
    }
    s = build_strata(preds)
    assert s["overall"]["canLaunchRows"] == 4, s["overall"]
    assert s["overall"]["canLaunchPositives"] == 2
    assert s["overall"]["launchedRows"] == 2
    assert s["overall"]["launchedFiredFish"] == 3 and s["overall"]["launchedHits"] == 2
    assert "pvp" in s["byMode"] and "pve" in s["byMode"]
    assert s["byMode"]["pvp"]["rows"] == 2
    assert s["byMode"]["event"]["canLaunchRows"] == 0
    assert s["byMode"]["pvp"]["headB"] is not None
    # launched/fired too small -> headC descriptive only
    assert s["overall"]["headCOutcome"] is None and s["overall"]["headCNote"]
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-aa external holdout stratified diagnosis")
    ap.add_argument("--predictions", default="")
    ap.add_argument("--dataset", default="")
    ap.add_argument("--ships", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("predictions", "dataset", "ships", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26aa] missing arguments: " + ", ".join(missing))
    class_of = load_ship_classes(Path(args.ships))
    preds = attach_metadata(load_predictions(Path(args.predictions)), Path(args.dataset), class_of)
    strata = build_strata(preds)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "_lineage": "E26e-aa external holdout stratified diagnosis (descriptive; no retraining)",
        "referenceInDistT4": IN_DIST,
        "strata": strata,
    }
    (out_dir / "external_stratify.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    write_markdown(strata, out_dir / "external_stratify_report.md")
    prov = strata["provenance"]
    print("[e26aa] rows " + str(prov["rows"]) + " replays " + str(prov["replays"])
          + " modes " + json.dumps(prov["modeRows"]) + " versions " + json.dumps(prov["versionRows"]))
    for label, key in (("overall", "overall"), ("pvp", "byMode"), ("non-pvp", "byModeGroup")):
        pass
    ov = strata["overall"]
    print("[e26aa] overall headB " + str(ov["headB"]) + " headC " + str(ov["headCOutcome"]))
    print("[e26aa] byMode keys " + str(list(strata["byMode"].keys())))
    print("[e26aa] summary -> " + str(out_dir / "external_stratify.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
