#!/usr/bin/env python3
"""E26e-ah: external event-mode focused slices (map / version / unknown / telemetry).

External: e26e-aa predictions + e26e-z dataset/outcome (event 5,671 rows; known event 2,273,
1,209 canLaunch / 10 positives; e15 3,398 unknown-class rows with canLaunch=0).
In-dist: E26e-g OOF + full 4-shard dataset (event 15,003 rows), sliced by the same
map / version / telemetry dimensions for comparison. 44-dim torp3 features are shared.
Descriptive only (no retraining).
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
from collections import Counter
from pathlib import Path

import numpy as np

import sys
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import train_fire_model as tfm  # noqa: E402
from train_torpedo_model import (  # noqa: E402
    TORP2_NAMES, TORP3_NAMES, class_of, derive_torp2_extras, derive_torp3_extras,
    head_b_metrics, load_ship_attributes, load_ship_classes,
)

CORE_NAMES = [
    "t", "ownSpeedKt", "ownHpFrac", "ownReloadFrac", "ownRangeM",
    "zonesOwned0", "zonesOwned1", "zonesOwned2", "zonesOwnedOther", "zonesActiveProgress",
    "eventsShells30s", "eventsTorps30s", "eventsExplosions30s", "eventsExplosionsNear30s",
    "ownDamconFrac", "ownRepairFrac", "ownOtherConsumableFrac", "ownEnginePower", "ownEngineDir",
    "ownInSmoke", "activeSmokeCountFrac", "activeSmokeAreaFeat", "visionCapFrac",
    "weatherIncomingFrac", "allyRadarCountFrac", "allyHydroCountFrac", "e11EventsKnown",
]
FEATURE_NAMES = CORE_NAMES + list(TORP2_NAMES) + list(TORP3_NAMES)
assert len(FEATURE_NAMES) == 44
SENTINEL_KEYS = ["ownEnginePower", "allyRadarCountFrac", "allyHydroCountFrac", "ownEngineDir"]
META_NAMES = ["enemyCount", "enemyDistMean", "enemySpeedMean", "enemyHpMean", "enemyTerrainFrac", "enemyObservedFrac"]
EXTERNAL_EVENT_REF = {
    "rows": 5671, "canLaunch": 1209, "positives": 10, "baseRate": 0.008271,
    "meanProbB": 0.035606, "ece15bin": 0.027335, "rocAuc": 0.552711,
    "topDecileLift": 0.0, "auprcMultiple": 1.357, "launched": 10, "fired": 29, "hits": 0,
}
IN_DIST_EVENT_REF = {"rows": 15003, "canLaunch": 7242, "positives": 118, "baseRate": 0.016294,
                     "meanProbB": 0.038321, "ece15bin": 0.022494, "rocAuc": 0.740965,
                     "topDecileLift": 2.9628, "auprcMultiple": 3.071, "launched": 118,
                     "fired": 358, "hits": 59}


def _open_text(path: Path):
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def _num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else np.nan
    except (TypeError, ValueError):
        return np.nan


def row_feature(row: dict, cls: str, attrs: dict, sid: int) -> np.ndarray:
    g = tfm.global_vector(row, 2)
    ex = derive_torp2_extras(row, cls) + derive_torp3_extras(row, cls, attrs, sid)
    return np.concatenate([g, np.asarray(ex, dtype=np.float32)])


def row_meta(row: dict) -> list:
    enemies = row.get("enemies") or []
    dists = [_num(e.get("distM")) for e in enemies]
    speeds = [_num(e.get("speedKt")) for e in enemies]
    hps = [_num(e.get("hpFrac")) for e in enemies]
    return [float(len(enemies)),
            float(np.mean(dists)) if dists else np.nan,
            float(np.mean(speeds)) if speeds else np.nan,
            float(np.mean(hps)) if hps else np.nan,
            float(np.mean([1.0 if e.get("terrainBlocked") else 0.0 for e in enemies])) if enemies else np.nan,
            float(np.mean([1.0 if e.get("observedNow") else 0.0 for e in enemies])) if enemies else np.nan]


def sentinel_flags(row: dict) -> list:
    out = []
    for key in SENTINEL_KEYS:
        v = row.get(key)
        try:
            out.append(1.0 if v is not None and float(v) == -1.0 else 0.0)
        except (TypeError, ValueError):
            out.append(1.0)
    return out


def stream_indist_event(paths: list, classes: dict, attrs: dict) -> dict:
    feats, metas, maps, versions, clss, sents, rowidx = [], [], [], [], [], [], []
    idx = 0
    for path in paths:
        with _open_text(Path(path)) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                if str(row.get("gameMode")) != "event":
                    idx += 1
                    continue
                sid_raw = row.get("shipId")
                sid = int(sid_raw) if sid_raw is not None else -1
                cls = class_of(sid if sid >= 0 else None, classes)
                feats.append(row_feature(row, cls, attrs, sid))
                metas.append(row_meta(row))
                maps.append(str(row.get("mapName")))
                versions.append(str(row.get("replayVersion")))
                clss.append(cls)
                sents.append(sentinel_flags(row))
                rowidx.append(idx)
                idx += 1
    return {"feats": np.asarray(feats, dtype=np.float32), "meta": np.asarray(metas, dtype=np.float32),
            "maps": np.asarray(maps, dtype=object), "versions": np.asarray(versions, dtype=object),
            "classes": np.asarray(clss, dtype=object), "sentinels": np.asarray(sents, dtype=np.float32),
            "rowidx": np.asarray(rowidx, dtype=np.int64), "rowsSeen": idx}


def load_external_event(preds_path: Path, dataset_path: Path, classes: dict, attrs: dict) -> dict:
    z = np.load(preds_path, allow_pickle=True)
    n = len(z["probB"])
    feats, metas, maps, versions, clss, sents, idxs = [], [], [], [], [], [], []
    i = 0
    with Path(dataset_path).open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            if i >= n:
                raise SystemExit("[e26ah] dataset has more rows than predictions")
            row = json.loads(line)
            if str(row.get("gameMode")) == "event":
                sid_raw = row.get("shipId")
                sid = int(sid_raw) if sid_raw is not None else -1
                cls = class_of(sid if sid >= 0 else None, classes)
                feats.append(row_feature(row, cls, attrs, sid))
                metas.append(row_meta(row))
                maps.append(str(row.get("mapName")))
                versions.append(str(row.get("replayVersion")))
                clss.append(cls)
                sents.append(sentinel_flags(row))
                idxs.append(i)
            i += 1
    if i != n:
        raise SystemExit("[e26ah] dataset rows " + str(i) + " != predictions " + str(n))
    idxs = np.asarray(idxs, dtype=np.int64)
    return {
        "feats": np.asarray(feats, dtype=np.float32), "meta": np.asarray(metas, dtype=np.float32),
        "maps": np.asarray(maps, dtype=object), "versions": np.asarray(versions, dtype=object),
        "classes": np.asarray(clss, dtype=object), "sentinels": np.asarray(sents, dtype=np.float32),
        "idx": idxs,
        "probB": z["probB"][idxs].astype(np.float64), "probC": z["probC"][idxs].astype(np.float64),
        "labelA": z["labelA"][idxs].astype(np.float64), "labelB": z["labelB"][idxs].astype(np.float64),
        "fired": z["fired"][idxs].astype(np.int64), "hits": z["hits"][idxs].astype(np.int64),
        "replayId": z["replayId"][idxs],
    }


def load_oof_event(path: Path, rowidx: np.ndarray) -> dict:
    z = np.load(path, allow_pickle=False)
    return {
        "probB": z["probB"][rowidx].astype(np.float64), "probC": z["probC"][rowidx].astype(np.float64),
        "labelA": z["labelA"][rowidx].astype(np.float64), "labelB": z["labelB"][rowidx].astype(np.float64),
        "classCode": z["classCode"][rowidx], "groupCode": z["groupCode"][rowidx],
        "t": z["t"][rowidx].astype(np.float64), "shipId": z["shipId"][rowidx].astype(np.int64),
    }


def headb_stats(prob: np.ndarray, label_a: np.ndarray, label_b: np.ndarray) -> dict:
    can = (label_a == 1.0) & np.isfinite(label_b)
    y = np.nan_to_num(label_b[can], nan=0.0)
    p = prob[can]
    base = float(y.mean()) if len(y) else None
    out = {"canLaunchRows": int(can.sum()), "positives": int(y.sum()), "baseRate": base,
           "meanProbB": (float(p.mean()) if len(p) else None)}
    if 0 < int(y.sum()) < len(y):
        m = head_b_metrics(y, p)
        out.update({"auprc": m.get("auprc"),
                    "auprcMultiple": (m.get("auprc") / base if m.get("auprc") is not None and base else None),
                    "topDecileLift": (m.get("topDecile") or {}).get("lift"),
                    "rocAuc": m.get("roc_auc"), "ece15bin": m.get("ece_15bin"),
                    "brier": m.get("brier"), "logloss": m.get("logloss")})
    else:
        out["note"] = "single-class or no positives: discrimination metrics undefined"
    return out


def outcome_counts(label_b: np.ndarray, fired: np.ndarray, hits: np.ndarray) -> dict:
    launched = (label_b == 1.0) & (fired >= 1)
    return {"launched": int(launched.sum()), "fired": int(fired[launched].sum()),
            "hits": int(hits[launched].sum()),
            "note": ("outcome lift not evaluated here (launched=" + str(int(launched.sum()))
                     + ", fired=" + str(int(fired[launched].sum())) + ", hits=" + str(int(hits[launched].sum())) + ")")}


def slice_metrics(ds: dict, mask, prob: np.ndarray, label_a: np.ndarray, label_b: np.ndarray) -> dict:
    mask = np.asarray(mask, dtype=bool)
    if not mask.any():
        return {"rows": 0, "headB": {}, "outcome": {}}
    return {"rows": int(mask.sum()), "headB": headb_stats(prob[mask], label_a[mask], label_b[mask]),
            "outcome": (outcome_counts(label_b[mask], ds["fired"][mask], ds["hits"][mask])
                        if "fired" in ds else None)}


def smd(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        ma, mb = np.nanmean(a, axis=0), np.nanmean(b, axis=0)
        va, vb = np.nanvar(a, axis=0), np.nanvar(b, axis=0)
    pooled = np.sqrt(np.maximum((va + vb) / 2.0, 1e-12))
    out = (ma - mb) / pooled
    return np.where(np.isfinite(out), out, 0.0)


def build_report(ext: dict, ind: dict, ind_oof: dict) -> dict:
    rep = {
        "provenance": {
            "externalEventRows": int(len(ext["maps"])),
            "indistEventRows": int(len(ind["maps"])),
            "indistRowsSeen": int(ind["rowsSeen"]),
            "externalMaps": dict(sorted(Counter(str(x) for x in ext["maps"]).items())),
            "indistMaps": dict(sorted(Counter(str(x) for x in ind["maps"]).items())),
            "externalVersions": dict(sorted(Counter(str(x) for x in ext["versions"]).items())),
            "indistVersions": dict(sorted(Counter(str(x) for x in ind["versions"]).items())),
            "mapOverlap": sorted(set(str(x) for x in ext["maps"]) & set(str(x) for x in ind["maps"])),
            "reference": {"externalEvent": EXTERNAL_EVENT_REF, "inDistEvent": IN_DIST_EVENT_REF},
        },
        "external": {},
        "indist": {},
        "featureDrift": {},
        "telemetry": {},
    }
    # external slices
    ext_prob = ext["probB"]
    ext_la = ext["labelA"]
    ext_lb = ext["labelB"]
    for name, mask in [("overall", np.ones(len(ext_prob), dtype=bool)),
                       ("knownClass", ext["classes"] != "unknown"),
                       ("unknownClass", ext["classes"] == "unknown")]:
        rep["external"][name] = slice_metrics(ext, mask, ext_prob, ext_la, ext_lb)
    for key in ("maps", "versions"):
        out = {}
        vals = ext[key]
        for v in sorted(set(str(x) for x in vals)):
            m = np.array([str(x) == v for x in vals], dtype=bool)
            out[v] = slice_metrics(ext, m, ext_prob, ext_la, ext_lb)
        rep["external"][key] = out
    # in-dist slices
    ind_prob = ind_oof["probB"]
    ind_la = ind_oof["labelA"]
    ind_lb = ind_oof["labelB"]
    rep["indist"]["overall"] = slice_metrics(ind, np.ones(len(ind_prob), dtype=bool), ind_prob, ind_la, ind_lb)
    for key in ("maps", "versions"):
        out = {}
        vals = ind[key]
        for v in sorted(set(str(x) for x in vals)):
            m = np.array([str(x) == v for x in vals], dtype=bool)
            out[v] = slice_metrics(ind, m, ind_prob, ind_la, ind_lb)
        rep["indist"][key] = out
    # version 15,9 comparison (shared version)
    for label, ds, prob, la, lb in (("external", ext, ext_prob, ext_la, ext_lb),
                                    ("indist", ind, ind_prob, ind_la, ind_lb)):
        m = np.array([str(x) == "15,9,0,0" for x in ds["versions"]], dtype=bool)
        rep[label]["version_15_9"] = slice_metrics(ds, m, prob, la, lb)
    # telemetry sentinel rates + headB by availability (external and in-dist)
    for label, ds, prob, la, lb in (("external", ext, ext_prob, ext_la, ext_lb),
                                    ("indist", ind, ind_prob, ind_la, ind_lb)):
        tel = {}
        sents = ds["sentinels"]
        for j, key in enumerate(SENTINEL_KEYS):
            smask = sents[:, j] > 0.5
            tel[key] = {"sentinelRate": float(smask.mean()),
                        "available": slice_metrics(ds, ~smask, prob, la, lb),
                        "sentinel": slice_metrics(ds, smask, prob, la, lb)}
        rep["telemetry"][label] = tel
    # feature drift (external event vs in-dist event)
    sm = smd(ext["feats"], ind["feats"])
    order = np.argsort(-np.abs(sm))[:15]
    rep["featureDrift"]["topSMD"] = [
        {"feature": FEATURE_NAMES[int(i)], "externalMean": float(np.nanmean(ext["feats"][:, int(i)])),
         "inDistMean": float(np.nanmean(ind["feats"][:, int(i)])), "smd": float(sm[int(i)])}
        for i in order
    ]
    ext_meta = ext["meta"]
    ind_meta = ind["meta"]
    rep["featureDrift"]["meta"] = [
        {"meta": META_NAMES[i], "externalMean": float(np.nanmean(ext_meta[:, i])),
         "inDistMean": float(np.nanmean(ind_meta[:, i])), "smd": float(smd(ext_meta[:, i:i+1], ind_meta[:, i:i+1])[0])}
        for i in range(len(META_NAMES))
    ]
    return rep


def _fmt(v, d=4):
    if v is None:
        return "-"
    if isinstance(v, float):
        if not math.isfinite(v):
            return "nan"
        return str(round(v, d))
    return str(v)


def write_markdown(rep: dict, path: Path):
    lines = ["# E26e-ah external event-mode slices", ""]
    p = rep["provenance"]
    lines.append("external event " + str(p["externalEventRows"]) + " rows; in-dist event " + str(p["indistEventRows"])
                 + " rows (" + str(p["indistRowsSeen"]) + " streamed); map overlap " + json.dumps(p["mapOverlap"]))
    lines.append("")
    lines.append("external versions " + json.dumps(p["externalVersions"]) + " | in-dist versions " + json.dumps(p["indistVersions"]))
    lines.append("")
    lines.append("## External event slices")
    lines.append("")
    lines.append("| slice | rows | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) | launched/fired/hits |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    def emit(label, s):
        hb = s.get("headB") or {}
        oc = s.get("outcome") or {}
        lines.append("| " + label + " | " + str(s.get("rows", 0)) + " | " + str(hb.get("canLaunchRows", 0)) + " (" + str(hb.get("positives", 0)) + ") | "
                     + _fmt(hb.get("baseRate")) + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | "
                     + _fmt(hb.get("rocAuc")) + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " | "
                     + str(oc.get("launched", "-")) + "/" + str(oc.get("fired", "-")) + "/" + str(oc.get("hits", "-")) + " |")
    emit("overall", rep["external"]["overall"])
    for name in ("knownClass", "unknownClass"):
        emit(name, rep["external"][name])
    for v, s in rep["external"].get("maps", {}).items():
        emit("map=" + v, s)
    for v, s in rep["external"].get("versions", {}).items():
        emit("version=" + v, s)
    lines.append("")
    lines.append("## In-dist event slices")
    lines.append("")
    lines.append("| slice | rows | canLaunch (pos) | base | meanProbB | ECE | AUC | top | AUPRC (x) |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    def emit2(label, s):
        hb = s.get("headB") or {}
        lines.append("| " + label + " | " + str(s.get("rows", 0)) + " | " + str(hb.get("canLaunchRows", 0)) + " (" + str(hb.get("positives", 0)) + ") | "
                     + _fmt(hb.get("baseRate")) + " | " + _fmt(hb.get("meanProbB")) + " | " + _fmt(hb.get("ece15bin")) + " | "
                     + _fmt(hb.get("rocAuc")) + " | " + _fmt(hb.get("topDecileLift")) + " | " + _fmt(hb.get("auprcMultiple"), 3) + " |")
    emit2("overall", rep["indist"]["overall"])
    for v, s in rep["indist"].get("maps", {}).items():
        emit2("map=" + v, s)
    for v, s in rep["indist"].get("versions", {}).items():
        emit2("version=" + v, s)
    lines.append("")
    lines.append("## Telemetry sentinel rates (external / in-dist event)")
    lines.append("")
    lines.append("| key | external sentinel rate | external available AUC | external sentinel AUC | in-dist sentinel rate | in-dist available AUC |")
    lines.append("|---|---|---|---|---|---|")
    for key in SENTINEL_KEYS:
        e = rep["telemetry"]["external"][key]
        i = rep["telemetry"]["indist"][key]
        lines.append("| " + key + " | " + _fmt(e["sentinelRate"], 3) + " | " + _fmt((e["available"].get("headB") or {}).get("rocAuc"))
                     + " | " + _fmt((e["sentinel"].get("headB") or {}).get("rocAuc"))
                     + " | " + _fmt(i["sentinelRate"], 3) + " | " + _fmt((i["available"].get("headB") or {}).get("rocAuc")) + " |")
    lines.append("")
    lines.append("## Feature drift (external event vs in-dist event, 44 dims)")
    lines.append("")
    for r in rep["featureDrift"]["topSMD"]:
        lines.append("- " + r["feature"] + ": ext " + _fmt(r["externalMean"]) + " vs in-dist " + _fmt(r["inDistMean"]) + " (SMD " + _fmt(r["smd"], 2) + ")")
    lines.append("")
    lines.append("meta: " + " | ".join(r["meta"] + " " + _fmt(r["smd"], 2) for r in rep["featureDrift"]["meta"]))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    import tempfile
    root = Path(tempfile.mkdtemp(prefix="e26ah-selftest-"))
    ds = root / "external.jsonl"
    base = {"ownSpeedKt": 20.0, "ownHpFrac": 0.5, "ownReloadFrac": 1.0, "ownRangeM": 10000.0,
            "zonesOwned0": 0, "zonesOwned1": 0, "zonesOwned2": 0, "zonesOwnedOther": 0,
            "zonesActiveProgress": 0.0, "eventsShells30s": 0, "eventsTorps30s": 0,
            "eventsExplosions30s": 0, "eventsExplosionsNear30s": 0, "enemies": [], "friends": []}
    rows = [
        dict(base, replayId="r1", t=1.0, shipId=11, gameMode="event", mapName="m1", replayVersion="v1",
             ownEnginePower=-1.0, allyRadarCountFrac=-1.0, allyHydroCountFrac=-1.0, ownEngineDir=-1.0),
        dict(base, replayId="r1", t=3.0, shipId=11, gameMode="event", mapName="m1", replayVersion="v1",
             ownEnginePower=0.5, allyRadarCountFrac=0.5, allyHydroCountFrac=0.5, ownEngineDir=1.0),
        dict(base, replayId="r2", t=1.0, shipId=22, gameMode="event", mapName="m2", replayVersion="v2",
             ownEnginePower=0.2, allyRadarCountFrac=0.2, allyHydroCountFrac=0.2, ownEngineDir=1.0),
    ]
    with ds.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + chr(10))
    preds = {"probA": np.array([.9, .8, .7]), "probB": np.array([.9, .2, .8]), "probC": np.array([.8, .3, .6]),
             "labelA": np.array([1.0, 1.0, 1.0]), "labelB": np.array([1.0, 0.0, 1.0]),
             "fired": np.array([2, 0, 1]), "hits": np.array([1, 0, 1]),
             "replayId": np.array(["r1", "r1", "r2"], dtype=object),
             "t": np.array([1.0, 3.0, 1.0]), "shipId": np.array([11, 11, 22])}
    pth = root / "preds.npz"
    np.savez_compressed(pth, **preds)
    classes = {11: "Destroyer", 22: "Cruiser"}
    ext = load_external_event(pth, ds, classes, {})
    assert len(ext["maps"]) == 3 and list(ext["classes"]) == ["Destroyer", "Destroyer", "Cruiser"]
    assert ext["sentinels"].shape == (3, 4) and ext["sentinels"][0, 0] == 1.0
    rep = {"x": 1}
    hb = headb_stats(ext["probB"], ext["labelA"], ext["labelB"])
    assert hb["canLaunchRows"] == 3 and hb["positives"] == 2
    # SMD direction
    a = np.array([[2.0], [2.0]]); b = np.array([[1.0], [1.0]])
    assert smd(a, b)[0] > 10
    # slice mask
    m = np.array([True, False, True])
    s = slice_metrics(ext, m, ext["probB"], ext["labelA"], ext["labelB"])
    assert s["rows"] == 2 and s["headB"]["canLaunchRows"] == 2
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-ah external event-mode focused slices")
    ap.add_argument("--predictions", default="")
    ap.add_argument("--external-dataset", default="")
    ap.add_argument("--indist", nargs="+", default=[])
    ap.add_argument("--oof", default="")
    ap.add_argument("--ships", default="")
    ap.add_argument("--ship-attrs", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("predictions", "external_dataset", "indist", "oof", "ships", "ship_attrs", "out_dir")
               if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26ah] missing arguments: " + ", ".join(missing))
    classes, _ = load_ship_classes(Path(args.ships))
    attrs = load_ship_attributes(Path(args.ship_attrs))
    print("[e26ah] streaming in-dist event rows...", flush=True)
    ind = stream_indist_event(args.indist, classes, attrs)
    print("[e26ah] in-dist event rows " + str(len(ind["maps"])) + " / seen " + str(ind["rowsSeen"]), flush=True)
    ind_oof = load_oof_event(Path(args.oof), ind["rowidx"])
    print("[e26ah] loading external event rows...", flush=True)
    ext = load_external_event(Path(args.predictions), Path(args.external_dataset), classes, attrs)
    print("[e26ah] external event rows " + str(len(ext["maps"])), flush=True)
    rep = build_report(ext, ind, ind_oof)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_lineage": "E26e-ah external event-mode focused slices (descriptive; no retraining)", "report": rep}
    (out_dir / "event_slices.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    write_markdown(rep, out_dir / "event_slices_report.md")
    print("[e26ah] external event overall: " + json.dumps(rep["external"]["overall"]["headB"]))
    for v, s in rep["external"].get("maps", {}).items():
        print("[e26ah] ext map=" + v + " rows " + str(s["rows"]) + " " + json.dumps(s["headB"]))
    for v, s in rep["external"].get("versions", {}).items():
        print("[e26ah] ext version=" + v + " rows " + str(s["rows"]) + " " + json.dumps(s["headB"]))
    print("[e26ah] in-dist event overall: " + json.dumps(rep["indist"]["overall"]["headB"]))
    for v, s in rep["indist"].get("versions", {}).items():
        print("[e26ah] indist version=" + v + " rows " + str(s["rows"]) + " " + json.dumps(s["headB"]))
    print("[e26ah] summary -> " + str(out_dir / "event_slices.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
