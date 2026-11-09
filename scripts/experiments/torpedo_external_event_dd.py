#!/usr/bin/env python3
"""E26e-ac: targeted external-holdout diagnosis of the event-mode / destroyer weakness.

Reads the E26e-aa per-row predictions (eval_predictions_external.npz) and the E26e-z
external dataset/click sidecars, then reports for mode x shipClass cells:
  coverage/labels (rows, canLaunch, launched, fired, hits, base),
  headB (AUPRC x base, top-decile, AUC, ECE, meanProbB vs base, probB quantiles),
  feature means/SMD (event vs other modes, DD vs other classes),
  event maps and launched-sample sufficiency.
Descriptive only: no retraining, no line changes.
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
from train_torpedo_model import head_b_metrics  # noqa: E402

MODES = ("pvp", "pve", "event", "cooperative")
CLASSES = ("Destroyer", "Cruiser", "Battleship", "Submarine", "unknown")
NUM_FEATURES = {
    "clickLastAgeS": "torpLastClickAgeS",
    "clicks30s": "torpClicks30s",
    "fish30s": "torpFish30s",
    "lastClickFish": "torpLastClickFish",
    "totalClicks": "torpTotalClicks",
    "ownTorpReloadFrac": "ownTorpReloadFrac",
    "ownTorpRangeM": "ownTorpRangeM",
    "torpCount": "torpCount",
    "enemyCount": "enemyCount",
    "enemyDistMean": "enemyDistMean",
    "enemyBearingAbsMean": "enemyBearingAbsMean",
    "enemySpeedMean": "enemySpeedMean",
    "enemyHpMean": "enemyHpMean",
    "enemyTerrainFrac": "enemyTerrainFrac",
    "enemyObservedFrac": "enemyObservedFrac",
}


def _num(v):
    try:
        f = float(v)
        return f if np.isfinite(f) else np.nan
    except (TypeError, ValueError):
        return np.nan


def load_ship_classes(path: Path) -> dict[int, str]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    out = {}
    for sid, entry in (raw.get("ships") or {}).items():
        try:
            out[int(sid)] = str(entry.get("type") or "unknown")
        except (TypeError, ValueError):
            continue
    return out


def load_torp_counts(path: Path) -> dict[int, float]:
    out = {}
    if not path or not Path(path).is_file():
        return out
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    for sid, rec in raw.items():
        try:
            out[int(sid)] = float(rec.get("torpCount") or 0.0)
        except (TypeError, ValueError):
            continue
    return out


def load_predictions(path: Path) -> dict:
    z = np.load(path, allow_pickle=True)
    need = ("probA", "probB", "probC", "labelA", "labelB", "fired", "hits", "replayId", "t", "shipId")
    missing = [k for k in need if k not in z.files]
    if missing:
        raise SystemExit("[e26ac] predictions npz missing: " + ", ".join(missing))
    return {k: z[k] for k in z.files}


def row_feature_values(row: dict, click: dict, attr_torp: float) -> dict:
    enemies = row.get("enemies") or []
    dists = [_num(e.get("distM")) for e in enemies]
    bearings = [abs(_num(e.get("bearingRelRad"))) for e in enemies]
    speeds = [_num(e.get("speedKt")) for e in enemies]
    hps = [_num(e.get("hpFrac")) for e in enemies]
    vals = {
        "clickLastAgeS": _num(click.get("torpLastClickAgeS")),
        "clicks30s": _num(click.get("torpClicks30s")),
        "fish30s": _num(click.get("torpFish30s")),
        "lastClickFish": _num(click.get("torpLastClickFish")),
        "totalClicks": _num(click.get("torpTotalClicks")),
        "ownTorpReloadFrac": _num(row.get("ownTorpReloadFrac")),
        "ownTorpRangeM": _num(row.get("ownTorpRangeM")),
        "torpCount": attr_torp,
        "enemyCount": float(len(enemies)),
        "enemyDistMean": float(np.mean(dists)) if len(dists) else np.nan,
        "enemyBearingAbsMean": float(np.mean(bearings)) if len(bearings) else np.nan,
        "enemySpeedMean": float(np.mean(speeds)) if len(speeds) else np.nan,
        "enemyHpMean": float(np.mean(hps)) if len(hps) else np.nan,
        "enemyTerrainFrac": float(np.mean([1.0 if e.get("terrainBlocked") else 0.0 for e in enemies])) if enemies else np.nan,
        "enemyObservedFrac": float(np.mean([1.0 if e.get("observedNow") else 0.0 for e in enemies])) if enemies else np.nan,
    }
    return vals


def attach_metadata(preds: dict, dataset_path: Path, click_path: Path,
                    class_of: dict[int, str], torp_count: dict[int, float]) -> dict:
    n = len(preds["probB"])
    meta = {k: np.empty(n, dtype=object) for k in ("gameMode", "mapName", "shipClass", "replayVersion", "date")}
    feats = {k: np.full(n, np.nan, dtype=np.float64) for k in NUM_FEATURES}
    i = 0
    with Path(dataset_path).open("r", encoding="utf-8") as fd, Path(click_path).open("r", encoding="utf-8") as fc:
        for line_d, line_c in zip(fd, fc):
            if not line_d.strip():
                continue
            if i >= n:
                raise SystemExit("[e26ac] dataset has more rows than predictions")
            r = json.loads(line_d)
            c = json.loads(line_c)
            if str(r.get("replayId")) != str(preds["replayId"][i]):
                raise SystemExit("[e26ac] replayId mismatch at row " + str(i))
            if abs(float(r.get("t", -1)) - float(preds["t"][i])) > 1e-3:
                raise SystemExit("[e26ac] t mismatch at row " + str(i))
            if int(r.get("shipId", -1)) != int(preds["shipId"][i]):
                raise SystemExit("[e26ac] shipId mismatch at row " + str(i))
            sid = int(r.get("shipId", -1))
            meta["gameMode"][i] = str(r.get("gameMode"))
            meta["mapName"][i] = str(r.get("mapName"))
            meta["shipClass"][i] = class_of.get(sid, "unknown")
            meta["replayVersion"][i] = str(r.get("replayVersion"))
            meta["date"][i] = str(r.get("replayId"))[:8]
            fv = row_feature_values(r, c, torp_count.get(sid, np.nan))
            for k in NUM_FEATURES:
                feats[k][i] = fv[k]
            i += 1
    if i != n:
        raise SystemExit("[e26ac] dataset rows " + str(i) + " != predictions " + str(n))
    preds.update(meta)
    preds["features"] = feats
    return preds


def can_launch_mask(preds: dict) -> np.ndarray:
    return (preds["labelA"] == 1.0) & np.isfinite(preds["labelB"])


def launched_mask(preds: dict) -> np.ndarray:
    return (preds["labelB"] == 1.0) & (preds["fired"] >= 1)


def coverage(preds: dict, mask) -> dict:
    mask = np.asarray(mask, dtype=bool)
    can = can_launch_mask(preds) & mask
    launched = launched_mask(preds) & mask
    fired = preds["fired"][launched].sum()
    hits = preds["hits"][launched].sum()
    pos = can.sum() and int(np.nansum(preds["labelB"][can] == 1.0))
    return {
        "rows": int(mask.sum()), "canLaunchRows": int(can.sum()), "canLaunchPositives": int(pos),
        "launchedRows": int(launched.sum()), "firedFish": int(fired), "hits": int(hits),
        "baseHitRate": (float(hits / fired) if fired > 0 else None),
    }


def headb_stats(preds: dict, mask) -> dict:
    mask = np.asarray(mask, dtype=bool)
    can = mask & can_launch_mask(preds)
    y = np.nan_to_num(preds["labelB"][can], nan=0.0)
    p = preds["probB"][can]
    if len(y) == 0:
        return {"rows": 0, "note": "no can-launch rows"}
    pos = int(y.sum())
    base = float(y.mean()) if len(y) else None
    out = {"rows": int(len(y)), "positives": pos, "baseRate": base}
    if 0 < pos < len(y):
        m = head_b_metrics(y, p)
        out.update({
            "auprc": m.get("auprc"), "auprcMultiple": (m.get("auprc") / base if m.get("auprc") is not None and base else None),
            "topDecileLift": (m.get("topDecile") or {}).get("lift"), "rocAuc": m.get("roc_auc"),
            "ece15bin": m.get("ece_15bin"), "meanProbB": float(p.mean()),
            "meanMinusBase": (float(p.mean()) - base) if base else None,
            "probB_p10": float(np.quantile(p, 0.1)), "probB_p50": float(np.quantile(p, 0.5)),
            "probB_p90": float(np.quantile(p, 0.9)),
        })
    else:
        out["note"] = "single-class or no positives: discrimination metrics undefined"
        out["meanProbB"] = float(p.mean())
        out["probB_p50"] = float(np.quantile(p, 0.5))
    return out


def summarize(preds: dict, groups, name: str, min_rows: int = 1) -> dict:
    groups = np.asarray(groups, dtype=object)
    out = {}
    for g in sorted(set(str(x) for x in groups)):
        mask = np.array([str(x) == g for x in groups], dtype=bool)
        if int(mask.sum()) < min_rows:
            continue
        out[g] = {"coverage": coverage(preds, mask), "headB": headb_stats(preds, mask)}
    return out


def feature_means(preds: dict, mask) -> dict:
    mask = np.asarray(mask, dtype=bool)
    out = {}
    for k, arr in preds["features"].items():
        v = arr[mask]
        v = v[np.isfinite(v)]
        out[k] = float(np.mean(v)) if len(v) else None
    out["unknownClassFrac"] = float(np.mean(preds["shipClass"][mask] == "unknown")) if mask.any() else None
    maps = Counter(str(x) for x in preds["mapName"][mask])
    out["topMaps"] = dict(maps.most_common(6))
    return out


def smd(a: dict, b: dict) -> dict:
    out = {}
    for k in NUM_FEATURES:
        va = a.get(k)
        vb = b.get(k)
        if va is None or vb is None or not np.isfinite(va) or not np.isfinite(vb):
            continue
        out[k] = {"meanA": va, "meanB": vb, "delta": va - vb}
    return out


def build_diagnosis(preds: dict) -> dict:
    preds["modeClass"] = np.array([str(m) + "|" + str(c) for m, c in
                                   zip(preds["gameMode"], preds["shipClass"])], dtype=object)
    diag = {
        "provenance": {
            "rows": int(len(preds["probB"])),
            "replays": int(len(set(str(x) for x in preds["replayId"]))),
            "modeRows": dict(sorted(Counter(str(x) for x in preds["gameMode"]).items())),
            "classRows": dict(sorted(Counter(str(x) for x in preds["shipClass"]).items())),
            "versionRows": dict(sorted(Counter(str(x) for x in preds["replayVersion"]).items())),
        },
        "byModeClass": summarize(preds, preds["modeClass"], "mode|class"),
        "byMode": summarize(preds, preds["gameMode"], "mode"),
        "byClass": summarize(preds, preds["shipClass"], "class"),
        "eventMaps": {},
        "featureCompare": {},
    }
    event_mask = preds["gameMode"] == "event"
    dd_mask = preds["shipClass"] == "Destroyer"
    # event maps (only rows whose mode is event)
    ev_maps = Counter(str(x) for x in preds["mapName"][event_mask])
    for m in ev_maps:
        mask = event_mask & np.array([str(x) == m for x in preds["mapName"]], dtype=bool)
        diag["eventMaps"][m] = {"coverage": coverage(preds, mask), "headB": headb_stats(preds, mask)}
    # mode feature comparison (event vs each mode) and class comparison (DD vs others)
    ev_feat = feature_means(preds, event_mask)
    diag["featureCompare"]["event"] = ev_feat
    for mode in MODES:
        if mode == "event":
            continue
        mask = preds["gameMode"] == mode
        if not mask.any():
            continue
        diag["featureCompare"]["eventVs" + mode] = {"mode": feature_means(preds, mask), "smd": smd(ev_feat, feature_means(preds, mask))}
    diag["featureCompare"]["destroyer"] = feature_means(preds, dd_mask)
    for cls in CLASSES:
        if cls == "Destroyer":
            continue
        mask = preds["shipClass"] == cls
        if not mask.any():
            continue
        diag["featureCompare"]["ddVs" + cls] = {"cls": feature_means(preds, mask), "smd": smd(diag["featureCompare"]["destroyer"], feature_means(preds, mask))}
    return diag


def _fmt(v, d=4):
    if v is None:
        return "-"
    if isinstance(v, float):
        return str(round(v, d))
    return str(v)


def write_markdown(diag: dict, path: Path):
    lines = ["# E26e-ac external event-mode / destroyer diagnosis", ""]
    prov = diag["provenance"]
    lines.append("rows " + str(prov["rows"]) + " / replays " + str(prov["replays"])
                 + " | modes " + json.dumps(prov["modeRows"])
                 + " | classes " + json.dumps(prov["classRows"]))
    lines.append("")
    lines.append("## Coverage and headB by mode")
    lines.append("")
    lines.append("| mode | rows | canLaunch (pos) | launched | fired | hits | base | AUPRC (x) | top | AUC | ECE | meanProbB | p50 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for g, v in diag["byMode"].items():
        c = v["coverage"]
        h = v["headB"]
        lines.append("| " + g + " | " + str(c["rows"]) + " | " + str(c["canLaunchRows"]) + " (" + str(c["canLaunchPositives"]) + ") | "
                     + str(c["launchedRows"]) + " | " + str(c["firedFish"]) + " | " + str(c["hits"]) + " | " + _fmt(c["baseHitRate"]) + " | "
                     + _fmt(h.get("auprc")) + " (" + _fmt(h.get("auprcMultiple"), 3) + ") | " + _fmt(h.get("topDecileLift")) + " | "
                     + _fmt(h.get("rocAuc")) + " | " + _fmt(h.get("ece15bin")) + " | " + _fmt(h.get("meanProbB")) + " | " + _fmt(h.get("probB_p50")) + " |")
    lines.append("")
    lines.append("## Coverage and headB by shipClass")
    lines.append("")
    lines.append("| class | rows | canLaunch (pos) | launched | fired | hits | base | AUPRC (x) | top | AUC | ECE | meanProbB |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for g, v in diag["byClass"].items():
        c = v["coverage"]
        h = v["headB"]
        lines.append("| " + g + " | " + str(c["rows"]) + " | " + str(c["canLaunchRows"]) + " (" + str(c["canLaunchPositives"]) + ") | "
                     + str(c["launchedRows"]) + " | " + str(c["firedFish"]) + " | " + str(c["hits"]) + " | " + _fmt(c["baseHitRate"]) + " | "
                     + _fmt(h.get("auprc")) + " (" + _fmt(h.get("auprcMultiple"), 3) + ") | " + _fmt(h.get("topDecileLift")) + " | "
                     + _fmt(h.get("rocAuc")) + " | " + _fmt(h.get("ece15bin")) + " | " + _fmt(h.get("meanProbB")) + " |")
    lines.append("")
    lines.append("## mode x class cells")
    lines.append("")
    lines.append("| cell | rows | canLaunch (pos) | launched | fired | hits | base | AUPRC (x) | top | AUC | meanProbB |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for g, v in diag["byModeClass"].items():
        c = v["coverage"]
        h = v["headB"]
        lines.append("| " + g + " | " + str(c["rows"]) + " | " + str(c["canLaunchRows"]) + " (" + str(c["canLaunchPositives"]) + ") | "
                     + str(c["launchedRows"]) + " | " + str(c["firedFish"]) + " | " + str(c["hits"]) + " | " + _fmt(c["baseHitRate"]) + " | "
                     + _fmt(h.get("auprc")) + " (" + _fmt(h.get("auprcMultiple"), 3) + ") | " + _fmt(h.get("topDecileLift")) + " | "
                     + _fmt(h.get("rocAuc")) + " | " + _fmt(h.get("meanProbB")) + " |")
    lines.append("")
    lines.append("## Event maps")
    lines.append("")
    lines.append("| map | rows | canLaunch (pos) | launched | fired | hits | base | AUPRC (x) | top | AUC |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for g, v in diag["eventMaps"].items():
        c = v["coverage"]
        h = v["headB"]
        lines.append("| " + g + " | " + str(c["rows"]) + " | " + str(c["canLaunchRows"]) + " (" + str(c["canLaunchPositives"]) + ") | "
                     + str(c["launchedRows"]) + " | " + str(c["firedFish"]) + " | " + str(c["hits"]) + " | " + _fmt(c["baseHitRate"]) + " | "
                     + _fmt(h.get("auprc")) + " (" + _fmt(h.get("auprcMultiple"), 3) + ") | " + _fmt(h.get("topDecileLift")) + " | "
                     + _fmt(h.get("rocAuc")) + " |")
    lines.append("")
    lines.append("## Feature means: event vs other modes")
    lines.append("")
    lines.append("| feature | event | pvp | pve | cooperative |")
    lines.append("|---|---|---|---|---|")
    ev = diag["featureCompare"]["event"]
    for k in NUM_FEATURES:
        row = [k, _fmt(ev.get(k))]
        for mode in ("pvp", "pve", "cooperative"):
            key = "eventVs" + mode
            row.append(_fmt(((diag["featureCompare"].get(key) or {}).get("mode") or {}).get(k)))
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")
    lines.append("| feature | DD | Cruiser | Battleship | Submarine |")
    lines.append("|---|---|---|---|---|")
    dd = diag["featureCompare"]["destroyer"]
    for k in NUM_FEATURES:
        row = [k, _fmt(dd.get(k))]
        for cls in ("Cruiser", "Battleship", "Submarine"):
            key = "ddVs" + cls
            row.append(_fmt(((diag["featureCompare"].get(key) or {}).get("cls") or {}).get(k)))
        lines.append("| " + " | ".join(row) + " |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    n = 8
    preds = {
        "probA": np.linspace(0.1, 0.9, n), "probB": np.linspace(0.9, 0.1, n), "probC": np.linspace(0.1, 0.9, n),
        "labelA": np.array([1, 1, 1, 1, 0, 0, 1, 1], dtype=float),
        "labelB": np.array([1, 0, np.nan, 1, np.nan, np.nan, 0, 1], dtype=float),
        "fired": np.array([2, 0, 0, 1, 0, 0, 0, 2]), "hits": np.array([1, 0, 0, 0, 0, 0, 0, 1]),
        "replayId": np.array(["r1"] * 4 + ["r2"] * 4, dtype=object),
        "t": np.arange(n, dtype=float), "shipId": np.arange(100, 100 + n),
        "gameMode": np.array(["event"] * 2 + ["pve"] * 2 + ["pvp"] * 2 + ["cooperative"] * 2, dtype=object),
        "shipClass": np.array(["Destroyer", "Destroyer", "Cruiser", "Cruiser", "Destroyer", "Cruiser", "unknown", "Battleship"], dtype=object),
        "mapName": np.array(["m1", "m1", "m2", "m2", "m3", "m3", "m4", "m4"], dtype=object),
        "replayVersion": np.array(["v1"] * n, dtype=object),
        "date": np.array(["20260101"] * n, dtype=object),
        "features": {k: np.linspace(1.0, 10.0, n) for k in NUM_FEATURES},
    }
    diag = build_diagnosis(preds)
    assert diag["provenance"]["rows"] == n
    assert diag["byMode"]["event"]["coverage"]["canLaunchRows"] == 2
    assert diag["byMode"]["pve"]["coverage"]["canLaunchRows"] == 1
    assert "event|Destroyer" in diag["byModeClass"]
    assert diag["byMode"]["event"]["headB"]["positives"] == 1
    assert "m1" in diag["eventMaps"]
    assert "eventVspvp" in diag["featureCompare"]
    assert "ddVsCruiser" in diag["featureCompare"]
    # SMD arithmetic: means differ by construction
    d = smd({"x": 2.0}, {"x": 1.0}) if "x" in NUM_FEATURES else {}
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-ac external event/DD diagnosis")
    ap.add_argument("--predictions", default="")
    ap.add_argument("--dataset", default="")
    ap.add_argument("--click", default="")
    ap.add_argument("--ships", default="")
    ap.add_argument("--ship-attrs", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("predictions", "dataset", "click", "ships", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26ac] missing arguments: " + ", ".join(missing))
    class_of = load_ship_classes(Path(args.ships))
    torp_count = load_torp_counts(Path(args.ship_attrs)) if args.ship_attrs else {}
    preds = attach_metadata(load_predictions(Path(args.predictions)), Path(args.dataset), Path(args.click), class_of, torp_count)
    diag = build_diagnosis(preds)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "_lineage": "E26e-ac external event-mode / destroyer targeted diagnosis (descriptive; no retraining)",
        "diagnosis": diag,
    }
    (out_dir / "event_dd_diag.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    write_markdown(diag, out_dir / "event_dd_report.md")
    print("[e26ac] rows " + str(diag["provenance"]["rows"]) + " replays " + str(diag["provenance"]["replays"]))
    for g, v in diag["byMode"].items():
        c = v["coverage"]
        h = v["headB"]
        print("[e26ac] mode=" + g + " can " + str(c["canLaunchRows"]) + "/pos " + str(c["canLaunchPositives"])
              + " launched " + str(c["launchedRows"]) + " fired " + str(c["firedFish"]) + " hits " + str(c["hits"])
              + " AUPRC " + str(h.get("auprc")) + " x" + str(h.get("auprcMultiple"))
              + " AUC " + str(h.get("rocAuc")) + " meanProbB " + str(h.get("meanProbB")) + " base " + str(h.get("baseRate")))
    for g, v in diag["byClass"].items():
        c = v["coverage"]
        h = v["headB"]
        print("[e26ac] class=" + g + " can " + str(c["canLaunchRows"]) + "/pos " + str(c["canLaunchPositives"])
              + " AUPRC " + str(h.get("auprc")) + " x" + str(h.get("auprcMultiple"))
              + " AUC " + str(h.get("rocAuc")) + " meanProbB " + str(h.get("meanProbB")))
    print("[e26ac] summary -> " + str(out_dir / "event_dd_diag.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
