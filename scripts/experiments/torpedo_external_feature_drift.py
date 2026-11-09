#!/usr/bin/env python3
"""E26e-af: external vs in-distribution feature drift attribution (torp3 44 dims).

Streams the external e26e-z corpus and the full 4-shard in-distribution corpus, builds the
same 44-dim torp3 global feature vector the model consumes (train_fire_model.global_vector +
torp2/torp3 extras), then reports:
  - per mode/class means, coverage and standardized mean difference (SMD),
  - categorical drift (unknown class, maps, modes, shipId novelty, enemy/own aggregates),
  - a domain classifier (in-dist vs external) with held-out AUC and top coefficients,
    overall and for event / DD / event|DD / pvp subsets.
Descriptive only (no retraining); the in-dist loader samples all non-pvp rows and every
N-th pvp row (pvp dominates 98% of the corpus) so event/DD cells keep full coverage.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import warnings
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
    load_ship_attributes, load_ship_classes,
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
assert len(FEATURE_NAMES) == 44, len(FEATURE_NAMES)
META_NAMES = ["enemyCount", "enemyDistMean", "enemySpeedMean", "enemyHpMean",
              "enemyTerrainFrac", "enemyObservedFrac"]


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


def row_meta(row: dict) -> list[float]:
    enemies = row.get("enemies") or []
    dists = [_num(e.get("distM")) for e in enemies]
    speeds = [_num(e.get("speedKt")) for e in enemies]
    hps = [_num(e.get("hpFrac")) for e in enemies]
    return [
        float(len(enemies)),
        float(np.mean(dists)) if dists else np.nan,
        float(np.mean(speeds)) if speeds else np.nan,
        float(np.mean(hps)) if hps else np.nan,
        float(np.mean([1.0 if e.get("terrainBlocked") else 0.0 for e in enemies])) if enemies else np.nan,
        float(np.mean([1.0 if e.get("observedNow") else 0.0 for e in enemies])) if enemies else np.nan,
    ]


def stream_corpus(paths: list, attrs: dict, classes: dict, pvp_every: int,
                  include_all: bool, shipid_set: set | None = None) -> dict:
    feats, metas, modes, maps, clss, ships, replays = [], [], [], [], [], [], []
    pvp_seen = 0
    row_count = 0
    for path in paths:
        with _open_text(Path(path)) as f:
            for line in f:
                if not line.strip():
                    continue
                row = json.loads(line)
                row_count += 1
                sid_raw = row.get("shipId")
                sid = int(sid_raw) if sid_raw is not None else -1
                if shipid_set is not None and sid >= 0:
                    shipid_set.add(sid)
                mode = str(row.get("gameMode"))
                if include_all:
                    take = True
                elif mode == "pvp":
                    take = (pvp_seen % max(pvp_every, 1) == 0)
                    pvp_seen += 1
                else:
                    take = True
                if not take:
                    continue
                cls = class_of(sid if sid >= 0 else None, classes)
                g = tfm.global_vector(row, 2)
                ex2 = derive_torp2_extras(row, cls)
                ex3 = derive_torp3_extras(row, cls, attrs, sid)
                feats.append(np.concatenate([g, np.asarray(ex2 + ex3, dtype=np.float32)]))
                metas.append(row_meta(row))
                modes.append(mode)
                maps.append(str(row.get("mapName")))
                clss.append(cls)
                ships.append(sid)
                replays.append(str(row.get("replayId")))
    return {
        "feats": np.asarray(feats, dtype=np.float32),
        "meta": np.asarray(metas, dtype=np.float32),
        "modes": np.asarray(modes, dtype=object),
        "maps": np.asarray(maps, dtype=object),
        "classes": np.asarray(clss, dtype=object),
        "ships": np.asarray(ships, dtype=np.int64),
        "replays": np.asarray(replays, dtype=object),
        "rowsSeen": row_count,
    }


def finite_coverage(arr: np.ndarray) -> np.ndarray:
    return np.isfinite(arr).mean(axis=0)


def smd(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Standardized mean difference per feature (a minus b) with pooled SD."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        ma, mb = np.nanmean(a, axis=0), np.nanmean(b, axis=0)
        va, vb = np.nanvar(a, axis=0), np.nanvar(b, axis=0)
    pooled = np.sqrt(np.maximum((va + vb) / 2.0, 1e-12))
    out = (ma - mb) / pooled
    return np.where(np.isfinite(out), out, 0.0)


def roc_auc(y: np.ndarray, score: np.ndarray) -> float:
    y = np.asarray(y, dtype=np.int64)
    score = np.asarray(score, dtype=np.float64)
    npos = int(y.sum())
    nneg = len(y) - npos
    if npos == 0 or nneg == 0:
        return 0.5
    order = np.argsort(score, kind="mergesort")
    ranks = np.empty(len(score), dtype=np.float64)
    ranks[order] = np.arange(1, len(score) + 1)
    return float((ranks[y == 1].sum() - npos * (npos + 1) / 2.0) / (npos * nneg))


def fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = 1e-3, iters: int = 20) -> np.ndarray:
    n, d = X.shape
    Xb = np.hstack([X, np.ones((n, 1))])
    w = np.zeros(d + 1)
    reg = np.eye(d + 1) * l2
    reg[-1, -1] = 0.0
    for _ in range(iters):
        z = Xb @ w
        p = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))
        W = np.maximum(p * (1.0 - p), 1e-6)
        grad = Xb.T @ (p - y) / n + l2 * w
        H = (Xb.T * W) @ Xb / n + reg
        try:
            step = np.linalg.solve(H, grad)
        except np.linalg.LinAlgError:
            break
        w -= step
        if np.max(np.abs(step)) < 1e-8:
            break
    return w


def standardize_fit(X: np.ndarray) -> tuple:
    mean = np.nanmean(X, axis=0)
    std = np.nanstd(X, axis=0)
    std = np.where(std < 1e-9, 1.0, std)
    return mean, std


def domain_test(ext: np.ndarray, ind: np.ndarray, seeds=(0, 1, 2), l2: float = 1e-3) -> dict:
    rng = np.random.default_rng(0)
    n = min(len(ext), len(ind))
    xe = ext[rng.choice(len(ext), size=n, replace=False)]
    xi = ind[rng.choice(len(ind), size=n, replace=False)]
    X = np.vstack([xe, xi])
    y = np.concatenate([np.ones(n, dtype=np.int64), np.zeros(n, dtype=np.int64)])
    aucs = []
    split_rng = np.random.default_rng(123)
    for _ in range(len(seeds)):
        idx = split_rng.permutation(len(X))
        ntr = int(len(idx) * 0.8)
        tr, te = idx[:ntr], idx[ntr:]
        mean, std = standardize_fit(X[tr])
        Xtr = np.clip((X[tr] - mean) / std, -8, 8)
        Xte = np.clip((X[te] - mean) / std, -8, 8)
        w = fit_logistic(Xtr, y[tr], l2=l2)
        pred = Xte @ w[:-1] + w[-1]
        aucs.append(roc_auc(y[te], pred))
    mean, std = standardize_fit(X)
    Xs = np.clip((X - mean) / std, -8, 8)
    wfull = fit_logistic(Xs, y, l2=l2)
    coef = wfull[:-1]
    order = np.argsort(-np.abs(coef))[:10]
    top = [{"feature": FEATURE_NAMES[int(i)], "coef": float(coef[int(i)])} for i in order]
    return {"nPerSide": int(n), "aucMean": float(np.mean(aucs)), "aucMin": float(np.min(aucs)),
            "aucMax": float(np.max(aucs)), "topFeatures": top}


def summarize_stratum(ext: dict, ind: dict, mask_ext, mask_ind) -> dict:
    fe = ext["feats"][mask_ext]
    fi = ind["feats"][mask_ind]
    if len(fe) == 0 or len(fi) == 0:
        return {"externalRows": int(len(fe)), "inDistRows": int(len(fi)), "note": "empty side"}
    sm = smd(fe, fi)
    order = np.argsort(-np.abs(sm))[:12]
    top = []
    for i in order:
        top.append({
            "feature": FEATURE_NAMES[int(i)],
            "externalMean": float(np.nanmean(fe[:, int(i)])),
            "inDistMean": float(np.nanmean(fi[:, int(i)])),
            "smd": float(sm[int(i)]),
            "externalCoverage": float(finite_coverage(fe)[int(i)]),
            "inDistCoverage": float(finite_coverage(fi)[int(i)]),
        })
    meta_fe = ext["meta"][mask_ext]
    meta_fi = ind["meta"][mask_ind]
    meta_top = []
    for i, name in enumerate(META_NAMES):
        msm = smd(meta_fe[:, i:i+1], meta_fi[:, i:i+1])[0]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            ext_mean = float(np.nanmean(meta_fe[:, i])) if np.isfinite(meta_fe[:, i]).any() else None
            ind_mean = float(np.nanmean(meta_fi[:, i])) if np.isfinite(meta_fi[:, i]).any() else None
        meta_top.append({"meta": name, "externalMean": ext_mean,
                         "inDistMean": ind_mean, "smd": float(msm)})
    return {
        "externalRows": int(len(fe)),
        "inDistRows": int(len(fi)),
        "externalUnknownClassFrac": float(np.mean(ext["classes"][mask_ext] == "unknown")),
        "inDistUnknownClassFrac": float(np.mean(ind["classes"][mask_ind] == "unknown")),
        "topSMD": top,
        "meta": meta_top,
    }


def top_categories(ext: dict, ind: dict, key: str, ext_mask, ind_mask) -> dict:
    ce = Counter(str(x) for x in ext[key][ext_mask])
    ci = Counter(str(x) for x in ind[key][ind_mask])
    unseen = {k: v for k, v in ce.items() if k not in ci}
    return {"externalTop": dict(ce.most_common(12)), "inDistTop": dict(ci.most_common(12)),
            "externalUnseenInDist": dict(sorted(unseen.items(), key=lambda kv: -kv[1])[:12]),
            "externalDistinct": len(ce), "inDistDistinct": len(ci)}


def build_report(ext: dict, ind: dict) -> dict:
    em, im = ext["modes"], ind["modes"]
    ec, ic = ext["classes"], ind["classes"]
    ev_e = em == "event"
    dd_e = ec == "Destroyer"
    evdd_e = ev_e & dd_e
    pvp_e = em == "pvp"
    ev_i = im == "event"
    dd_i = ic == "Destroyer"
    evdd_i = ev_i & dd_i
    pvp_i = im == "pvp"
    rep = {
        "provenance": {
            "externalRows": int(len(em)), "externalReplays": int(len(set(ext["replays"]))),
            "inDistRowsSeen": int(ind["rowsSeen"]), "inDistRowsSampled": int(len(im)),
            "inDistReplays": int(len(set(ind["replays"]))),
            "externalModeRows": dict(sorted(Counter(str(x) for x in em).items())),
            "inDistModeRowsSampled": dict(sorted(Counter(str(x) for x in im).items())),
            "externalClassRows": dict(sorted(Counter(str(x) for x in ec).items())),
            "inDistClassRowsSampled": dict(sorted(Counter(str(x) for x in ic).items())),
            "featureNames": FEATURE_NAMES,
        },
        "strata": {
            "overall": summarize_stratum(ext, ind, np.ones(len(em), bool), np.ones(len(im), bool)),
            "event": summarize_stratum(ext, ind, ev_e, ev_i),
            "destroyer": summarize_stratum(ext, ind, dd_e, dd_i),
            "eventDestroyer": summarize_stratum(ext, ind, evdd_e, evdd_i),
            "pvp": summarize_stratum(ext, ind, pvp_e, pvp_i),
        },
        "categorical": {
            "modes": {"external": dict(sorted(Counter(str(x) for x in em).items())),
                      "inDistSampled": dict(sorted(Counter(str(x) for x in im).items()))},
            "classes": {"external": dict(sorted(Counter(str(x) for x in ec).items())),
                        "inDistSampled": dict(sorted(Counter(str(x) for x in ic).items()))},
            "eventMaps": top_categories(ext, ind, "maps", ev_e, ev_i),
            "allMaps": top_categories(ext, ind, "maps", np.ones(len(em), bool), np.ones(len(im), bool)),
        },
        "domainClassifier": {},
    }
    # shipId novelty (external ids that never appear in the in-dist sample)
    ext_ids = set(int(x) for x in ext["ships"] if x >= 0)
    ind_ids = set(int(x) for x in ind["ships"] if x >= 0)
    rep["categorical"]["shipIdNovelty"] = {
        "externalDistinct": len(ext_ids), "inDistDistinctSampled": len(ind_ids),
        "externalUnseenFrac": (float(len(ext_ids - ind_ids)) / len(ext_ids)) if ext_ids else None,
        "externalUnseenTop": sorted(list(ext_ids - ind_ids))[:20],
    }
    subsets = {
        "overall": (np.ones(len(em), bool), np.ones(len(im), bool)),
        "event": (ev_e, ev_i),
        "destroyer": (dd_e, dd_i),
        "eventDestroyer": (evdd_e, evdd_i),
        "pvp": (pvp_e, pvp_i),
    }
    for name, (me, mi) in subsets.items():
        if me.sum() == 0 or mi.sum() == 0:
            rep["domainClassifier"][name] = {"note": "empty side", "externalRows": int(me.sum()),
                                             "inDistRows": int(mi.sum())}
            continue
        rep["domainClassifier"][name] = domain_test(ext["feats"][me], ind["feats"][mi])
        rep["domainClassifier"][name]["externalRows"] = int(me.sum())
        rep["domainClassifier"][name]["inDistRows"] = int(mi.sum())
    return rep


def sanitize(o):
    """Recursively convert non-finite floats to None so the JSON is strict."""
    if isinstance(o, dict):
        return {k: sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [sanitize(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def _fmt(v, d=4):
    if v is None:
        return "-"
    if isinstance(v, float):
        if not math.isfinite(v):
            return "nan"
        return str(round(v, d))
    return str(v)


def write_markdown(rep: dict, path: Path):
    lines = ["# E26e-af external vs in-distribution feature drift (torp3 44 dims)", ""]
    p = rep["provenance"]
    lines.append("external " + str(p["externalRows"]) + " rows / " + str(p["externalReplays"]) + " replays; in-dist sampled "
                 + str(p["inDistRowsSampled"]) + " / " + str(p["inDistRowsSeen"]) + " rows / " + str(p["inDistReplays"]) + " replays")
    lines.append("")
    lines.append("external modes " + json.dumps(p["externalModeRows"]) + " | in-dist sampled modes " + json.dumps(p["inDistModeRowsSampled"]))
    lines.append("")
    lines.append("## Top SMD features by stratum (external minus in-dist)")
    lines.append("")
    for name, s in rep["strata"].items():
        if "topSMD" not in s:
            continue
        lines.append("### " + name + " (external " + str(s["externalRows"]) + " vs in-dist " + str(s["inDistRows"]) + ")")
        lines.append("")
        lines.append("| feature | external mean | in-dist mean | SMD | ext coverage | in-dist coverage |")
        lines.append("|---|---|---|---|---|---|")
        for r in s["topSMD"]:
            lines.append("| " + r["feature"] + " | " + _fmt(r["externalMean"]) + " | " + _fmt(r["inDistMean"]) + " | "
                         + _fmt(r["smd"], 3) + " | " + _fmt(r["externalCoverage"], 3) + " | " + _fmt(r["inDistCoverage"], 3) + " |")
        lines.append("")
        lines.append("meta: " + " | ".join(r["meta"] + " " + _fmt(r["smd"], 2) for r in s["meta"]))
        lines.append("")
    lines.append("## Domain classifier (in-dist vs external, 44 dims, held-out AUC)")
    lines.append("")
    lines.append("| subset | n/side | AUC mean | AUC range | top features (coef sign) |")
    lines.append("|---|---|---|---|---|")
    for name, d in rep["domainClassifier"].items():
        if "aucMean" not in d:
            continue
        top = ", ".join(t["feature"] + "(" + ("+" if t["coef"] >= 0 else "-") + ")" for t in d["topFeatures"][:5])
        lines.append("| " + name + " | " + str(d["nPerSide"]) + " | " + _fmt(d["aucMean"], 3) + " | "
                     + _fmt(d["aucMin"], 3) + "-" + _fmt(d["aucMax"], 3) + " | " + top + " |")
    lines.append("")
    lines.append("## Categorical drift")
    lines.append("")
    lines.append("modes: " + json.dumps(rep["categorical"]["modes"]))
    lines.append("")
    lines.append("classes: " + json.dumps(rep["categorical"]["classes"]))
    lines.append("")
    lines.append("event maps (external top / unseen in-dist): "
                 + json.dumps(rep["categorical"]["eventMaps"]["externalTop"]) + " / "
                 + json.dumps(rep["categorical"]["eventMaps"]["externalUnseenInDist"]))
    lines.append("")
    lines.append("all maps unseen in-dist (external rows): " + json.dumps(rep["categorical"]["allMaps"]["externalUnseenInDist"]))
    lines.append("")
    lines.append("shipId novelty: " + json.dumps(rep["categorical"]["shipIdNovelty"]))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    rng = np.random.default_rng(0)
    a = rng.normal(0, 1, size=(100, 4))
    b = rng.normal(1, 1, size=(100, 4))
    sm = smd(a, b)
    assert abs(sm[0] + 1.0) < 0.4 and abs(sm[1] + 1.0) < 0.4, sm
    y = np.array([1, 1, 0, 0])
    assert roc_auc(y, np.array([0.9, 0.8, 0.2, 0.1])) == 1.0
    assert roc_auc(y, np.array([0.1, 0.2, 0.8, 0.9])) == 0.0
    X = np.vstack([rng.normal(0, 1, size=(100, 4)), rng.normal(3, 1, size=(100, 4))])
    yy = np.concatenate([np.zeros(100), np.ones(100)])
    mean, std = standardize_fit(X)
    w = fit_logistic((X - mean) / std, yy)
    pred = (X - mean) / std @ w[:-1] + w[-1]
    auc = roc_auc(yy, pred)
    assert auc > 0.9, auc
    res = domain_test(X[:100], X[100:], seeds=(0,))
    assert res["aucMean"] > 0.9, res
    # row-level feature builder shape + meta
    row = {"t": 10.0, "ownSpeedKt": 20.0, "ownHpFrac": 0.5, "ownReloadFrac": 1.0, "ownRangeM": 10000.0,
           "zonesOwned0": 1, "zonesOwned1": 0, "zonesOwned2": 0, "zonesOwnedOther": 0,
           "zonesActiveProgress": 0.5, "eventsShells30s": 1, "eventsTorps30s": 0,
           "eventsExplosions30s": 0, "eventsExplosionsNear30s": 0, "enemies": [],
           "friends": [], "gameMode": "event", "mapName": "m", "shipId": 1}
    f = np.concatenate([tfm.global_vector(row, 2), np.asarray(derive_torp2_extras(row, "Destroyer")
                                                               + derive_torp3_extras(row, "Destroyer", {}, 1), dtype=np.float32)])
    assert f.shape == (44,), f.shape
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-af external vs in-distribution feature drift")
    ap.add_argument("--external", default="")
    ap.add_argument("--indist", nargs="+", default=[])
    ap.add_argument("--ships", default="")
    ap.add_argument("--ship-attrs", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--pvp-every", type=int, default=10)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("external", "indist", "ships", "ship_attrs", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26af] missing arguments: " + ", ".join(missing))
    classes, _ = load_ship_classes(Path(args.ships))
    attrs = load_ship_attributes(Path(args.ship_attrs))
    print("[e26af] streaming external corpus...", flush=True)
    ext = stream_corpus([Path(args.external)], attrs, classes, pvp_every=1, include_all=True)
    ind_shipids: set = set()
    print("[e26af] streaming in-dist corpus (non-pvp all, pvp every " + str(args.pvp_every) + ")...", flush=True)
    ind = stream_corpus([Path(p) for p in args.indist], attrs, classes,
                        pvp_every=int(args.pvp_every), include_all=False, shipid_set=ind_shipids)
    rep = build_report(ext, ind)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_lineage": "E26e-af external vs in-distribution torpedo feature drift (descriptive)", "report": rep}
    (out_dir / "external_feature_drift.json").write_text(
        json.dumps(sanitize(payload), indent=1, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    write_markdown(rep, out_dir / "external_feature_drift_report.md")
    print("[e26af] external " + str(len(ext["modes"])) + " rows; in-dist sampled " + str(len(ind["modes"]))
          + "/" + str(ind["rowsSeen"]) + " rows")
    for name, d in rep["domainClassifier"].items():
        if "aucMean" in d:
            print("[e26af] domain " + name + ": AUC " + str(round(d["aucMean"], 3))
                  + " [" + str(round(d["aucMin"], 3)) + "," + str(round(d["aucMax"], 3)) + "]"
                  + " n/side " + str(d["nPerSide"]))
    for name in ("event", "destroyer", "eventDestroyer"):
        s = rep["strata"][name]
        top = ", ".join(r["feature"] for r in s["topSMD"][:6])
        print("[e26af] " + name + " top SMD: " + top)
    print("[e26af] summary -> " + str(out_dir / "external_feature_drift.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
