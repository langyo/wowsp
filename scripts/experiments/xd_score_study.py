#!/usr/bin/env python3
"""E21: xG-style realized-minus-expected whole-game scoring study.

Pre-registered BEFORE computation (README E21):
  split        exploration = apac + own; confirmation = eu + na
  calibration  on the exploration set ONLY: mean hpLost per p-decile over
               FIRED can-fire windows of all ships (10 deciles, lowest
               decile fill for out-of-range p)
  candidates
    X1 xD-sum   sum over FIRED windows of (hpLost - calib(p))
    X2 xD-rate  X1 / n_fired (per-shot conversion above expectation)
    X3 rawDmg   sum hpLost over FIRED windows (realized volume*quality ctrl)
    X4 ratio    sum hpLost / sum calib(p) over FIRED windows
    C7 firedRate / C5 valueRecall (E20 reference carryovers)
  pick rule    best positive Spearman rho vs damage on exploration; ties by
               semantic order X1 > X2 > X4
  acceptance   the PICK, run ONCE on confirmation: rho(damage) >= 0.30
               + within-replay pooled rank rho reported
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent / "out" / "score_validation"
EXPLORE = ["apac", "own"]
CONFIRM = ["eu", "na"]
TIE = ["X1", "X2", "X4"]


def spearman(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    good = np.isfinite(x) & np.isfinite(y)
    x, y = x[good], y[good]
    n = len(x)
    if n < 10:
        return float("nan"), n
    rx = np.argsort(np.argsort(x)).astype(float)
    ry = np.argsort(np.argsort(y)).astype(float)
    rx = (rx - rx.mean()) / (rx.std() or 1.0)
    ry = (ry - ry.mean()) / (ry.std() or 1.0)
    return float((rx * ry).mean()), n


def load(shards):
    ships = []
    for s in shards:
        with open(BASE / f"scores_e21_{s}.jsonl", encoding="utf-8") as f:
            for line in f:
                rep = json.loads(line)
                for ps in rep["perShip"]:
                    oc = ps.get("outcome") or {}
                    if oc.get("status") != "ok":
                        continue
                    p, fired, hp = [], [], []
                    for x in ps.get("samples") or []:
                        if x.get("fireProb") is None or x.get("fired") is None:
                            continue
                        p.append(x["fireProb"])
                        fired.append(bool(x["fired"]))
                        hp.append(float(x.get("hpLost") or 0.0))
                    p = np.array(p)
                    fired = np.array(fired, bool)
                    hp = np.array(hp)
                    ships.append(
                        {
                            "replay": rep["replayId"],
                            "damage": float(oc.get("damage") or 0.0),
                            "p": p,
                            "fired": fired,
                            "hp": hp,
                        }
                    )
    return ships


def calib_curve(ships, bins=10):
    """Mean realized hpLost per p-decile over FIRED windows (explore only)."""
    ps, hs = [], []
    for s in ships:
        m = s["fired"]
        ps.append(s["p"][m])
        hs.append(s["hp"][m])
    p = np.concatenate(ps)
    h = np.concatenate(hs)
    edges = np.linspace(0.0, 1.0, bins + 1)
    idx = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    means = np.zeros(bins)
    for b in range(bins):
        sel = h[idx == b]
        means[b] = sel.mean() if len(sel) >= 20 else h.mean()
    return means, edges


def score_ship(s, means, edges):
    m = s["fired"]
    if not m.any():
        return {"X1": np.nan, "X2": np.nan, "X3": 0.0, "X4": np.nan,
                "C7": 0.0, "C5": np.nan}
    p, hp = s["p"][m], s["hp"][m]
    idx = np.clip(np.digitize(p, edges) - 1, 0, len(means) - 1)
    exp = means[idx]
    realized, expected = hp.sum(), exp.sum()
    x1 = realized - expected
    allm = np.ones(len(s["p"]), bool)
    return {
        "X1": x1,
        "X2": x1 / len(p),
        "X3": realized,
        "X4": realized / expected if expected > 1e-6 else np.nan,
        "C7": float(m.mean()),
        "C5": float((s["p"] * s["fired"]).sum() / s["p"].sum()) if s["p"].sum() > 0 else np.nan,
    }


def within_rho(ships, keyed, key, min_ships=4):
    by = {}
    for s, k in zip(ships, keyed):
        by.setdefault(s["replay"], []).append(k[key])
    dmg_by = {}
    for s in ships:
        dmg_by.setdefault(s["replay"], []).append(s["damage"])
    rs, ns = [], []
    for rep in by:
        if len(by[rep]) < min_ships:
            continue
        r, n = spearman(by[rep], dmg_by[rep])
        if math.isfinite(r):
            rs.append(r)
            ns.append(n)
    return float(np.average(rs, weights=ns)) if rs else float("nan")


def main():
    explore = load(EXPLORE)
    print(f"[e21] exploration: {len(explore)} ships")
    means, edges = calib_curve(explore)
    print(f"[e21] calibration decile means: {[round(x) for x in means]}")
    keyed = [score_ship(s, means, edges) for s in explore]
    dmg = [s["damage"] for s in explore]
    res = {}
    for k in TIE + ["X3", "C7", "C5"]:
        r, n = spearman([x[k] for x in keyed], dmg)
        res[k] = r
        print(f"[e21:explore] {k}: rho(damage)={r:+.4f} n={n}")
    pos = {k: v for k, v in res.items() if math.isfinite(v) and v > 0}
    if not pos:
        print("[e21] NO positive candidate — honest stop")
        return
    best = max(pos.values())
    tied = [k for k, v in pos.items() if v >= best - 1e-9]
    pick = min(tied, key=lambda k: TIE.index(k) if k in TIE else 99)
    print(f"[e21] PICK {pick} (explore {pos[pick]:+.4f}); confirming on {CONFIRM}")
    confirm = load(CONFIRM)
    ck = [score_ship(s, means, edges) for s in confirm]
    r, n = spearman([x[pick] for x in ck], [s["damage"] for s in confirm])
    wr = within_rho(confirm, ck, pick)
    print(
        f"[e21] CONFIRM {pick}: rho(damage)={r:+.4f} n={n}; within-replay pooled={wr:+.4f}"
        f" -> {'PASS (rho>=0.30)' if r >= 0.30 else 'FAIL (honest report)'}"
    )


if __name__ == "__main__":
    main()
