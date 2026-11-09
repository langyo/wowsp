#!/usr/bin/env python3
"""E26e-t: temporal-drift diagnosis of the Q3 walk-forward collapse (no retraining).

Inputs (all local):
  split_summary.json  -- Q1..Q4 replayId lists / date ranges
  dataset_own_2s.jsonl -- full own shard (rows filtered to the Q blocks)
  click_own.jsonl / r120 outcome_own.jsonl -- aligned sidecars
  e26e-s/runQ{2,3,4}/holdout_ensemble.npz -- fold-ensemble predictions per test block
  e26e-s/baseline0_Q{2,3,4}_oof.npz -- 0%% (E26e-o) predictions per test block

Outputs:
  drift_summary.json  -- per-block composition, per-window prediction metrics,
                        feature/category drift (SMD/KS/PSI), Q3 anomaly table
  drift_report.md     -- readable tables

This is descriptive: it does not retrain or change any model/threshold.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from torpedo_outcome_lift import decile_table, top_decile_lift  # noqa: E402

BLOCKS = ("Q1", "Q2", "Q3", "Q4")
NUM_FEATURES = [
    "enemyCount", "enemyDistMean", "enemyBearingAbsMean", "enemySpeedMean",
    "enemyHpMean", "enemyTerrainBlockedFrac", "enemyInsideSmokeFrac",
    "enemyRadarLitFrac", "enemyObservedNowFrac",
    "ownTorpRangeM", "ownTorpReloadFrac", "ownReloadFrac",
    "torpClicks30s", "torpFish30s", "torpLastClickAgeS", "torpLastClickFish",
    "torpTotalClicks",
]
CAT_FEATURES = ("gameMode", "mapName", "shipClass", "shipId")


def _num(v, default=None):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _mean(xs):
    return float(np.mean(xs)) if len(xs) else None


def load_meta(ships_path: Path, attrs_path: Path):
    ships = json.loads(Path(ships_path).read_text(encoding="utf-8"))
    class_of = {}
    for sid, info in ships.get("ships", {}).items():
        if isinstance(info, dict) and info.get("type"):
            class_of[int(sid)] = str(info["type"])
    attrs = {}
    if attrs_path and Path(attrs_path).exists():
        raw = json.loads(Path(attrs_path).read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            attrs = {int(k): v for k, v in raw.items() if isinstance(v, dict)}
    return class_of, attrs


def row_features(row, click_rec, attrs_map):
    enemies = row.get("enemies") or []
    dists = [_num(e.get("distM")) for e in enemies if _num(e.get("distM")) is not None]
    bearings = [_num(e.get("bearingRelRad")) for e in enemies if _num(e.get("bearingRelRad")) is not None]
    speeds = [_num(e.get("speedKt")) for e in enemies if _num(e.get("speedKt")) is not None]
    hps = [_num(e.get("hpFrac")) for e in enemies if _num(e.get("hpFrac")) is not None]
    sid = row.get("shipId")
    attrs = attrs_map.get(int(sid)) if sid is not None else None
    attrs = attrs or {}
    return {
        "enemyCount": float(len(enemies)),
        "enemyDistMean": float(np.mean(dists)) if dists else np.nan,
        "enemyBearingAbsMean": float(np.mean([abs(b) for b in bearings])) if bearings else np.nan,
        "enemySpeedMean": float(np.mean(speeds)) if speeds else np.nan,
        "enemyHpMean": float(np.mean(hps)) if hps else np.nan,
        "enemyTerrainBlockedFrac": float(np.mean([1.0 if e.get("terrainBlocked") else 0.0 for e in enemies])) if enemies else 0.0,
        "enemyInsideSmokeFrac": float(np.mean([1.0 if e.get("insideSmoke") else 0.0 for e in enemies])) if enemies else 0.0,
        "enemyRadarLitFrac": float(np.mean([1.0 if e.get("radarLit") else 0.0 for e in enemies])) if enemies else 0.0,
        "enemyObservedNowFrac": float(np.mean([1.0 if e.get("observedNow") else 0.0 for e in enemies])) if enemies else 0.0,
        "ownTorpRangeM": _num(row.get("ownTorpRangeM"), np.nan),
        "ownTorpReloadFrac": _num(row.get("ownTorpReloadFrac"), np.nan),
        "ownReloadFrac": _num(row.get("ownReloadFrac"), np.nan),
        "torpClicks30s": _num((click_rec or {}).get("torpClicks30s"), np.nan),
        "torpFish30s": _num((click_rec or {}).get("torpFish30s"), np.nan),
        "torpLastClickAgeS": _num((click_rec or {}).get("torpLastClickAgeS"), np.nan),
        "torpLastClickFish": _num((click_rec or {}).get("torpLastClickFish"), np.nan),
        "torpTotalClicks": _num((click_rec or {}).get("torpTotalClicks"), np.nan),
        "torpCount": _num(attrs.get("torpCount"), np.nan),
    }


def aggregate_blocks(dataset_path, click_path, outcome_path, split_summary, class_of, attrs_map):
    blocks = {q: set(split_summary["blocks"][q]["replayIds"]) for q in BLOCKS}
    replay_block = {}
    for q, ids in blocks.items():
        for rid in ids:
            replay_block[rid] = q
    agg = {q: {
        "rows": 0, "launched": 0, "firedFish": 0, "hits": 0, "rowAnyHit": 0,
        "catCounts": {c: {} for c in CAT_FEATURES},
        "numSamples": {f: [] for f in NUM_FEATURES},
        "torpAttr": {"torpCount": [], "torpSpeed": [], "torpDamage": [], "torpDetect": [], "torpDeep": []},
        "clickCovered": 0,
        "rowGameModes": [], "rowT": [], "rowShipId": [], "modeStats": {},
    } for q in BLOCKS}
    n = 0
    with Path(dataset_path).open("r", encoding="utf-8") as fd, \
         Path(click_path).open("r", encoding="utf-8") as fc, \
         Path(outcome_path).open("r", encoding="utf-8") as fo:
        for line_d, line_c, line_o in zip(fd, fc, fo):
            if not line_d.strip():
                continue
            row = json.loads(line_d)
            rid = row["replayId"]
            q = replay_block.get(rid)
            if q is None:
                continue
            click_rec = json.loads(line_c)
            out = json.loads(line_o)
            if (click_rec.get("replayId") != rid or str(out.get("replayId")) != rid
                    or abs(float(click_rec.get("t", -1)) - float(row["t"])) > 1e-3):
                raise SystemExit("[e26t] sidecar misalignment at row " + str(n))
            st = agg[q]
            n += 1
            st["rows"] += 1
            st["rowGameModes"].append(str(row.get("gameMode")))
            st["rowT"].append(float(row.get("t")))
            st["rowShipId"].append(int(row.get("shipId")) if row.get("shipId") is not None else -1)
            fired = int(out.get("torpFiredFish", 0) or 0)
            hits = int(out.get("torpHits", 0) or 0)
            launched = bool(row.get("labelBLaunched")) and fired > 0
            if launched:
                st["launched"] += 1
                st["firedFish"] += fired
                st["hits"] += hits
                if hits > 0:
                    st["rowAnyHit"] += 1
                mode = str(row.get("gameMode"))
                ms = st["modeStats"].setdefault(mode, {"launched": 0, "firedFish": 0, "hits": 0})
                ms["launched"] += 1
                ms["firedFish"] += fired
                ms["hits"] += hits
            feats = row_features(row, click_rec, attrs_map)
            for f in NUM_FEATURES:
                v = feats[f]
                if v is not None and np.isfinite(v):
                    st["numSamples"][f].append(float(v))
            sid = row.get("shipId")
            if click_rec.get("torpClicks30s") is not None:
                st["clickCovered"] += 1
            for cname, val in (("gameMode", str(row.get("gameMode"))), ("mapName", str(row.get("mapName"))),
                               ("shipClass", class_of.get(int(sid), "unknown") if sid is not None else "unknown"),
                               ("shipId", str(sid))):
                d = st["catCounts"][cname]
                d[val] = d.get(val, 0) + 1
            attrs = attrs_map.get(int(sid)) if sid is not None else None
            if attrs:
                for k in ("torpCount", "torpSpeed", "torpDamage", "torpDetect", "torpDeep"):
                    v = _num(attrs.get(k))
                    if v is not None:
                        st["torpAttr"][k].append(v)
    if n == 0:
        raise SystemExit("[e26t] no rows matched the Q blocks")
    out = {}
    for q in BLOCKS:
        st = agg[q]
        launched = st["launched"]
        row = {
            "rows": st["rows"], "launched": st["launched"], "firedFish": st["firedFish"], "hits": st["hits"],
            "baseHitRate": (st["hits"] / st["firedFish"]) if st["firedFish"] else None,
            "rowAnyHitRate": (st["rowAnyHit"] / launched) if launched else None,
            "gameModeTop": sorted(st["catCounts"]["gameMode"].items(), key=lambda kv: -kv[1])[:5],
            "mapTop": sorted(st["catCounts"]["mapName"].items(), key=lambda kv: -kv[1])[:8],
            "shipClassTop": sorted(st["catCounts"]["shipClass"].items(), key=lambda kv: -kv[1]),
            "clickCovered": st["clickCovered"],
            "torpAttrMean": {k: _mean(v) for k, v in st["torpAttr"].items()},
            "modeStats": {m: dict(v, baseHitRate=(v["hits"] / v["firedFish"]) if v["firedFish"] else None)
                          for m, v in st["modeStats"].items()},
            "numMean": {f: _mean(st["numSamples"][f]) for f in NUM_FEATURES},
        }
        out[q] = {"summary": row, "numSamples": st["numSamples"], "catCounts": st["catCounts"],
                  "rowGameModes": st["rowGameModes"], "rowT": st["rowT"], "rowShipId": st["rowShipId"]}
    return out


def auc(y, p):
    y = np.asarray(y, dtype=np.float64)
    p = np.asarray(p, dtype=np.float64)
    pos = int(y.sum())
    neg = len(y) - pos
    if pos == 0 or neg == 0:
        return None
    order = np.argsort(p, kind="mergesort")
    ranks = np.empty(len(p), dtype=np.float64)
    ranks[order] = np.arange(1, len(p) + 1, dtype=np.float64)
    _, inv = np.unique(p, return_inverse=True)
    for g in np.unique(inv):
        m = inv == g
        ranks[m] = ranks[m].mean()
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2.0) / (pos * neg))


def ece(y, p, bins=10):
    y = np.asarray(y, dtype=np.float64)
    p = np.asarray(p, dtype=np.float64)
    edges = np.linspace(0.0, 1.0, bins + 1)
    total = 0.0
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        m = (p >= lo) & ((p < hi) if i < bins - 1 else (p <= hi))
        if not m.any():
            continue
        total += int(m.sum()) * abs(float(y[m].mean()) - float(p[m].mean()))
    return float(total / len(y)) if len(y) else None


def prediction_metrics(npz_path, game_modes=None, expect_ts=None, expect_sids=None):
    z = np.load(npz_path, allow_pickle=False)
    lb = z["labelB"].astype(np.float64)
    fired = z["fired"].astype(np.float64)
    hits = z["hits"].astype(np.float64)
    prob = z["probC"].astype(np.float64)
    if game_modes is not None:
        if len(game_modes) != len(lb):
            raise SystemExit("[e26t] gameMode rows " + str(len(game_modes)) + " != predictions " + str(len(lb)))
        if expect_ts is not None and "t" in z.files:
            n_probe = min(50, len(lb))
            if not np.allclose(np.asarray(z["t"][:n_probe], dtype=np.float64), np.asarray(expect_ts[:n_probe], dtype=np.float64), atol=1e-3):
                raise SystemExit("[e26t] prediction row order does not match the dataset block order")
        if expect_sids is not None and "shipId" in z.files:
            n_probe = min(50, len(lb))
            if not np.array_equal(np.asarray(z["shipId"][:n_probe], dtype=np.int64), np.asarray(expect_sids[:n_probe], dtype=np.int64)):
                raise SystemExit("[e26t] prediction shipId order does not match the dataset block order")
    mask = (lb == 1.0) & (fired >= 1)
    y = (hits[mask] > 0).astype(np.float64)
    p = prob[mask]
    f = fired[mask]
    h = hits[mask]
    base = float(h.sum() / f.sum()) if f.sum() > 0 else None
    table = decile_table(p, f, h)
    official_lift = top_decile_lift(table, base) if base else None
    order = np.argsort(-p, kind="mergesort")
    k = max(1, len(p) // 10)
    top = order[:k]
    top_rate = float(h[top].sum() / f[top].sum()) if f[top].sum() > 0 else None
    by_mode = {}
    if game_modes is not None:
        modes = np.asarray(game_modes, dtype=object)
        for mode in sorted(set(str(m) for m in modes[mask])):
            sel = mask & (modes == mode)
            f_m = fired[sel]; h_m = hits[sel]; p_m = prob[sel]
            if f_m.sum() <= 0:
                continue
            b_m = float(h_m.sum() / f_m.sum())
            tab_m = decile_table(p_m, f_m, h_m)
            by_mode[str(mode)] = {
                "rows": int(sel.sum()), "firedFish": int(f_m.sum()), "hits": int(h_m.sum()),
                "baseHitRate": b_m, "meanProbC": float(p_m.mean()),
                "topDecileFishLift": top_decile_lift(tab_m, b_m) if f_m.sum() >= 50 else None,
            }
    out = {
        "rows": int(mask.sum()), "firedFish": int(f.sum()), "hits": int(h.sum()),
        "baseHitRate": base, "rowAnyHitRate": float(y.mean()) if len(y) else None,
        "meanProbC": float(p.mean()) if len(p) else None,
        "brier": float(np.mean((p - y) ** 2)) if len(y) else None,
        "ece_10bin": ece(y, p), "auc": auc(y, p),
        "topDecileFishLift": official_lift,
        "topDecileFishLiftDecile": (top_rate / base) if (top_rate is not None and base) else None,
        "topDecileHitRate": top_rate,
        "meanProbMinusRowHit": (float(p.mean()) - float(y.mean())) if len(p) else None,
    }
    out["byMode"] = by_mode
    return out


def _psi(cat_a: dict, cat_b: dict, alpha=1e-6):
    keys = sorted(set(cat_a) | set(cat_b))
    n_a = sum(cat_a.values()) or 1
    n_b = sum(cat_b.values()) or 1
    total = 0.0
    for k in keys:
        pa = cat_a.get(k, 0) / n_a
        pb = cat_b.get(k, 0) / n_b
        total += (pa - pb) * math.log((pa + alpha) / (pb + alpha))
    return float(total)


def _ks(sample_a, sample_b):
    a = np.sort(np.asarray(sample_a, dtype=np.float64))
    b = np.sort(np.asarray(sample_b, dtype=np.float64))
    if len(a) == 0 or len(b) == 0:
        return None
    grid = np.concatenate([a, b])
    ca = np.searchsorted(a, grid, side="right") / len(a)
    cb = np.searchsorted(b, grid, side="right") / len(b)
    return float(np.max(np.abs(ca - cb)))


def numeric_drift(a, b):
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    a = a[np.isfinite(a)]
    b = b[np.isfinite(b)]
    if len(a) == 0 or len(b) == 0:
        return {"smd": None, "ks": None, "meanA": None, "meanB": None}
    mean_a, mean_b = float(a.mean()), float(b.mean())
    var_a = float(a.var(ddof=1)) if len(a) > 1 else 0.0
    var_b = float(b.var(ddof=1)) if len(b) > 1 else 0.0
    pooled = math.sqrt(max((var_a + var_b) / 2.0, 1e-12))
    return {"smd": (mean_a - mean_b) / pooled, "ks": _ks(a, b), "meanA": mean_a, "meanB": mean_b,
            "stdA": math.sqrt(var_a), "stdB": math.sqrt(var_b)}


def window_drift(adapt_q, test_q, blocks):
    out = {"window": adapt_q + "->" + test_q, "numeric": {}, "categorical": {}, "label": {}}
    for f in NUM_FEATURES:
        out["numeric"][f] = numeric_drift(blocks[adapt_q]["numSamples"][f], blocks[test_q]["numSamples"][f])
    for c in CAT_FEATURES:
        out["categorical"][c] = {"psi": _psi(blocks[adapt_q]["catCounts"][c], blocks[test_q]["catCounts"][c])}
    a = blocks[adapt_q]["summary"]
    t = blocks[test_q]["summary"]
    out["label"] = {
        "adaptBaseHitRate": a["baseHitRate"], "testBaseHitRate": t["baseHitRate"],
        "baseHitRateDelta": (t["baseHitRate"] - a["baseHitRate"]) if (a["baseHitRate"] is not None and t["baseHitRate"] is not None) else None,
        "rowAnyHitRateDelta": (t["rowAnyHitRate"] - a["rowAnyHitRate"]) if (a["rowAnyHitRate"] is not None and t["rowAnyHitRate"] is not None) else None,
        "launchedDelta": t["launched"] - a["launched"],
        "rowsDelta": t["rows"] - a["rows"],
    }
    return out


def top_drift(window, k=6):
    items = []
    for f, d in window["numeric"].items():
        if d.get("smd") is not None:
            items.append({"kind": "num", "name": f, "smd": d["smd"], "ks": d["ks"],
                          "abs": abs(d["smd"]) + (d["ks"] or 0.0)})
    for c, d in window["categorical"].items():
        if d.get("psi") is not None:
            items.append({"kind": "cat", "name": c, "psi": d["psi"], "abs": abs(d["psi"])})
    items.sort(key=lambda x: -x["abs"])
    return items[:k]


def build_summary(blocks, windows, preds, baselines):
    summary = {
        "_lineage": "E26e-t temporal drift diagnosis (descriptive; no retraining)",
        "blocks": {q: blocks[q]["summary"] for q in BLOCKS},
        "windows": windows,
        "predictions": preds,
        "baseline0": baselines,
    }
    # Q3 anomaly table relative to Q2/Q4 test windows
    q3 = {"blockMetrics": {}, "predMetrics": {}, "drift": {}}
    for key in ("baseHitRate", "rowAnyHitRate", "launched", "firedFish", "hits", "rows"):
        q3["blockMetrics"][key] = {q: blocks[q]["summary"][key] for q in ("Q2", "Q3", "Q4")}
    for name, m in (("runQ2", preds["runQ2"]), ("runQ3", preds["runQ3"]), ("runQ4", preds["runQ4"])):
        q3["predMetrics"].setdefault("meanProbC", {})[name] = m.get("meanProbC")
        q3["predMetrics"].setdefault("ece_10bin", {})[name] = m.get("ece_10bin")
        q3["predMetrics"].setdefault("auc", {})[name] = m.get("auc")
        q3["predMetrics"].setdefault("topDecileFishLift", {})[name] = m.get("topDecileFishLift")
    w23 = windows["Q2->Q3"]
    w34 = windows["Q3->Q4"]
    w12 = windows["Q1->Q2"]
    q3["drift"]["Q2->Q3"] = top_drift(w23)
    q3["drift"]["Q3->Q4"] = top_drift(w34)
    q3["drift"]["Q1->Q2"] = top_drift(w12)
    q3["labelNoiseNote"] = (
        "proxy labels only: no per-block server-truth outcome at scale; E26e-m recorder-only audit is 710 rows / "
        "3,212 fish globally, too few per Q block to identify label noise. Cannot decide label noise vs prior drift "
        "from these data alone."
    )
    summary["q3_anomaly"] = q3
    return summary


def _fmt(v, digits=4):
    if v is None:
        return "-"
    if isinstance(v, float):
        return str(round(v, digits))
    return str(v)


def write_markdown(summary: dict, path: Path):
    lines = ["# E26e-t temporal drift report", ""]
    lines.append("## Q1-Q4 composition")
    lines.append("")
    lines.append("| block | rows | launched | fired | hits | baseHitRate | rowAnyHitRate | top gameMode | top map |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for q in BLOCKS:
        s = summary["blocks"][q]
        gm = ", ".join(str(k) + ":" + str(v) for k, v in s["gameModeTop"][:2])
        mp = ", ".join(str(k) + ":" + str(v) for k, v in s["mapTop"][:2])
        lines.append("| " + q + " | " + str(s["rows"]) + " | " + str(s["launched"]) + " | " + str(s["firedFish"])
                     + " | " + str(s["hits"]) + " | " + _fmt(s["baseHitRate"]) + " | " + _fmt(s["rowAnyHitRate"])
                     + " | " + gm + " | " + mp + " |")
    lines.append("")
    lines.append("## Predictions (test block)")
    lines.append("")
    lines.append("| run | rows | baseHitRate | meanProbC | ECE | AUC | top-decile lift |")
    lines.append("|---|---|---|---|---|---|---|")
    for name in ("runQ2", "runQ3", "runQ4"):
        m = summary["predictions"][name]
        lines.append("| " + name + " | " + str(m["rows"]) + " | " + _fmt(m["baseHitRate"]) + " | " + _fmt(m["meanProbC"])
                     + " | " + _fmt(m["ece_10bin"]) + " | " + _fmt(m["auc"]) + " | " + _fmt(m["topDecileFishLift"]) + " |")
    lines.append("")
    for name in ("runQ2", "runQ3", "runQ4"):
        m = summary["baseline0"][name]
        lines.append("0% " + name + ": meanProbC " + _fmt(m["meanProbC"]) + " ECE " + _fmt(m["ece_10bin"])
                     + " AUC " + _fmt(m["auc"]) + " lift " + _fmt(m["topDecileFishLift"]))
    lines.append("")
    lines.append("## Top drift items per window")
    lines.append("")
    for wname, items in summary["q3_anomaly"]["drift"].items():
        lines.append("### " + wname)
        for it in items:
            if it["kind"] == "num":
                lines.append("- num " + it["name"] + ": SMD " + str(round(it["smd"], 3)) + " KS " + str(round(it["ks"] or 0, 3)))
            else:
                lines.append("- cat " + it["name"] + ": PSI " + str(round(it["psi"], 3)))
        lines.append("")
    lines.append("## Q3 anomaly (test block vs neighbouring test blocks)")
    lines.append("")
    lines.append("| metric | Q2 test | Q3 test | Q4 test |")
    lines.append("|---|---|---|---|")
    bm = summary["q3_anomaly"]["blockMetrics"]
    for key in ("rows", "launched", "firedFish", "hits", "baseHitRate", "rowAnyHitRate"):
        row = bm.get(key, {})
        lines.append("| " + key + " | " + _fmt(row.get("Q2")) + " | " + _fmt(row.get("Q3")) + " | " + _fmt(row.get("Q4")) + " |")
    pm = summary["q3_anomaly"]["predMetrics"]
    for key in ("meanProbC", "ece_10bin", "auc", "topDecileFishLift"):
        row = pm.get(key, {})
        lines.append("| " + key + " | " + _fmt(row.get("runQ2")) + " | " + _fmt(row.get("runQ3")) + " | " + _fmt(row.get("runQ4")) + " |")
    lines.append("")
    lines.append("## Game-mode composition")
    lines.append("")
    modes = ["pvp", "brawl", "event", "pve", "ranked"]
    lines.append("| block | " + " | ".join(modes) + " |")
    lines.append("|---|" + "---|" * len(modes))
    for q in BLOCKS:
        s = summary["blocks"][q]
        counts = dict(s["gameModeTop"])
        allc = {}
        for m2, v in summary["blocks"][q].get("modeStats", {}).items():
            allc[m2] = allc.get(m2, 0) + v["launched"]
        lines.append("| " + q + " | " + " | ".join(str(counts.get(m2, 0)) for m2 in modes) + " |")
    lines.append("")
    lines.append("## Base hit rate by game mode (launched / fired / hits / base)")
    lines.append("")
    lines.append("| block | " + " | ".join(modes) + " |")
    lines.append("|---|" + "---|" * len(modes))
    for q in BLOCKS:
        cells = []
        ms = summary["blocks"][q].get("modeStats", {})
        for m2 in modes:
            v = ms.get(m2)
            if v:
                cells.append(str(v["launched"]) + "/" + str(v["firedFish"]) + "/" + str(v["hits"]) + "/" + str(round(v["baseHitRate"], 3)))
            else:
                cells.append("-")
        lines.append("| " + q + " | " + " | ".join(cells) + " |")
    lines.append("")
    lines.append("## Per-mode prediction metrics")
    lines.append("")
    for name in ("runQ2", "runQ3", "runQ4"):
        lines.append("### " + name)
        lines.append("")
        lines.append("| mode | rows | fired | hits | baseHitRate | meanProbC | topDecileFishLift |")
        lines.append("|---|---|---|---|---|---|---|")
        for m2, v in sorted(summary["predictions"][name].get("byMode", {}).items()):
            lines.append("| " + m2 + " | " + str(v["rows"]) + " | " + str(v["firedFish"]) + " | " + str(v["hits"])
                         + " | " + _fmt(v["baseHitRate"]) + " | " + _fmt(v["meanProbC"]) + " | " + _fmt(v["topDecileFishLift"]) + " |")
        lines.append("")
    lines.append("")
    lines.append("## Per-mode 0% baseline metrics")
    lines.append("")
    for name in ("runQ2", "runQ3", "runQ4"):
        lines.append("### 0% " + name)
        lines.append("")
        lines.append("| mode | rows | fired | hits | baseHitRate | meanProbC | topDecileFishLift |")
        lines.append("|---|---|---|---|---|---|---|")
        for m2, v in sorted(summary["baseline0"][name].get("byMode", {}).items()):
            lines.append("| " + m2 + " | " + str(v["rows"]) + " | " + str(v["firedFish"]) + " | " + str(v["hits"])
                         + " | " + _fmt(v["baseHitRate"]) + " | " + _fmt(v["meanProbC"]) + " | " + _fmt(v["topDecileFishLift"]) + " |")
        lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    # numeric drift helpers
    a = np.array([1.0, 2.0, 3.0, 4.0])
    b = np.array([1.0, 2.0, 3.0, 4.0])
    d = numeric_drift(a, b)
    assert d["smd"] == 0.0 and d["ks"] == 0.0, d
    d2 = numeric_drift(a, a + 10.0)
    assert abs(d2["ks"] - 1.0) < 1e-12, d2
    # categorical PSI: identical -> 0, disjoint -> large
    ca = {"x": 10, "y": 10}
    assert abs(_psi(ca, ca)) < 1e-9
    assert _psi(ca, {"z": 20}) > 1.0
    # ece/auc sanity
    y = np.array([0.0, 0.0, 1.0, 1.0])
    p = np.array([0.0, 0.0, 1.0, 1.0])
    assert ece(y, p) is not None and ece(y, p) < 1e-9
    assert abs(auc(y, p) - 1.0) < 1e-9
    assert abs(auc(y, p[::-1]) - 0.0) < 1e-9
    # prediction metrics on synthetic npz
    import tempfile
    root = Path(tempfile.mkdtemp(prefix="e26t-selftest-"))
    n = 20
    z = root / "p.npz"
    np.savez_compressed(z,
        labelB=np.array([1.0] * 10 + [0.0] * 10, dtype=np.float32),
        fired=np.array([2] * 10 + [0] * 10, dtype=np.int32),
        hits=np.array([1] * 10 + [0] * 10, dtype=np.int32),
        probC=np.linspace(0.9, 0.1, n).astype(np.float32))
    m = prediction_metrics(z)
    assert m["rows"] == 10 and m["baseHitRate"] == 0.5, m
    # top_drift ordering
    w = {"numeric": {"f1": {"smd": 0.1, "ks": 0.2}, "f2": {"smd": 1.0, "ks": 0.5}},
         "categorical": {"c1": {"psi": 0.05}}}
    assert top_drift(w, 2)[0]["name"] == "f2"
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-t temporal drift diagnosis")
    ap.add_argument("--dataset", default="")
    ap.add_argument("--click", default="")
    ap.add_argument("--outcome", default="")
    ap.add_argument("--split-summary", default="")
    ap.add_argument("--ships", default="")
    ap.add_argument("--ship-attrs", default="")
    ap.add_argument("--runs-dir", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    need = ("dataset", "click", "outcome", "split_summary", "ships", "runs_dir", "out_dir")
    missing = [k for k in need if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26t] missing arguments: " + ", ".join(missing))
    split = json.loads(Path(args.split_summary).read_text(encoding="utf-8"))
    class_of, attrs_map = load_meta(Path(args.ships), Path(args.ship_attrs) if args.ship_attrs else None)
    print("[e26t] ship class map " + str(len(class_of)) + " entries, attributes " + str(len(attrs_map)) + " entries")
    if not attrs_map:
        print("[e26t] WARNING: ship attributes empty; torpAttr means will be null")
    blocks = aggregate_blocks(args.dataset, args.click, args.outcome, split, class_of, attrs_map)
    windows = {}
    for adapt_q, test_q in (("Q1", "Q2"), ("Q2", "Q3"), ("Q3", "Q4")):
        windows[adapt_q + "->" + test_q] = window_drift(adapt_q, test_q, blocks)
    runs_dir = Path(args.runs_dir)
    preds = {}
    baselines = {}
    for run, block in (("runQ2", "Q2"), ("runQ3", "Q3"), ("runQ4", "Q4")):
        preds[run] = prediction_metrics(runs_dir / run / "holdout_ensemble.npz",
                                        blocks[block]["rowGameModes"], blocks[block]["rowT"], blocks[block]["rowShipId"])
        baselines[run] = prediction_metrics(runs_dir / ("baseline0_" + block + "_oof.npz"),
                                            blocks[block]["rowGameModes"], blocks[block]["rowT"], blocks[block]["rowShipId"])
    summary = build_summary(blocks, windows, preds, baselines)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "drift_summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    write_markdown(summary, out_dir / "drift_report.md")
    print("[e26t] blocks:")
    for q in BLOCKS:
        s = blocks[q]["summary"]
        print("  " + q + " rows " + str(s["rows"]) + " launched " + str(s["launched"]) + " fired " + str(s["firedFish"])
              + " hits " + str(s["hits"]) + " base " + str(s["baseHitRate"]))
    for run in ("runQ2", "runQ3", "runQ4"):
        m = preds[run]
        b = baselines[run]
        print("[e26t] " + run + ": meanProbC " + str(m["meanProbC"]) + " base " + str(m["baseHitRate"])
              + " ECE " + str(m["ece_10bin"]) + " lift " + str(m["topDecileFishLift"])
              + " | 0% meanProbC " + str(b["meanProbC"]) + " ECE " + str(b["ece_10bin"]) + " lift " + str(b["topDecileFishLift"]))
    print("[e26t] summary -> " + str(out_dir / "drift_summary.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
