#!/usr/bin/env python3
"""E20: whole-game score aggregation study (true (p, fired) pairs).

Pre-registered BEFORE computation (README E20):
  split      exploration = apac + own; confirmation = eu + na
  candidates (over can-fire samples of each ship):
    C1 meanP(actual)      — the E17 aggregation (known to invert)
    C2 medianP(actual)
    C3 top-quartile meanP(actual)
    C4 recall@p>=0.5      — fired in / (fired in + held) model-endorsed windows
    C5 valueRecall        — sum(p*fired) / sum(p)  (captured model-value share)
    C6 valuePerShot       — sum(p*fired) / sum(fired)
    C7 firedRate          — raw volume control
    C8 moveMedian         — move-agreement control
  pick rule   best positive Spearman rho vs damage on exploration; ties by
              semantic order C5 > C4 > C6 > C3 > C2 > C7 > C8
  acceptance  the PICK, run ONCE on confirmation: rho(damage) >= 0.30
              (the unchanged E17 line) + within-replay pooled rank rho
No re-picking after the confirmation run.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent / "out" / "score_validation"
EXPLORE = ["apac", "own"]
CONFIRM = ["eu", "na"]
TIE = ["C5", "C4", "C6", "C3", "C2", "C7", "C8"]


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
        with open(BASE / f"scores_e20_{s}.jsonl", encoding="utf-8") as f:
            for line in f:
                rep = json.loads(line)
                for ps in rep["perShip"]:
                    oc = ps.get("outcome") or {}
                    if oc.get("status") != "ok":
                        continue
                    samples = ps.get("samples") or []
                    p = np.array(
                        [x["fireProb"] for x in samples if x.get("fireProb") is not None]
                    )
                    fired = np.array(
                        [x["fired"] for x in samples if x.get("fired") is not None], float
                    )
                    moves = [x["move"] for x in samples if x.get("move") is not None]
                    p_act = np.where(fired > 0.5, p, 1.0 - p)
                    endorsed = p >= 0.5
                    sum_p = p.sum()
                    ships.append(
                        {
                            "replay": rep["replayId"],
                            "damage": float(oc.get("damage") or 0.0),
                            "base_exp": float(oc.get("baseExp") or 0.0),
                            "C1": float(p_act.mean()) if len(p_act) else np.nan,
                            "C2": float(np.median(p_act)) if len(p_act) else np.nan,
                            "C3": (
                                float(np.sort(p_act)[int(0.75 * len(p_act)) :].mean())
                                if len(p_act)
                                else np.nan
                            ),
                            "C4": (
                                float(fired[endorsed].mean()) if endorsed.any() else np.nan
                            ),
                            "C5": float((p * fired).sum() / sum_p) if sum_p > 0 else np.nan,
                            "C6": (
                                float((p * fired).sum() / fired.sum()) if fired.sum() > 0 else np.nan
                            ),
                            "C7": float(fired.mean()) if len(fired) else np.nan,
                            "C8": float(np.median(moves)) if moves else np.nan,
                        }
                    )
    return ships


def within_rho(ships, key, min_ships=4):
    by = {}
    for s in ships:
        by.setdefault(s["replay"], []).append(s)
    rs, ns = [], []
    for rows in by.values():
        if len(rows) < min_ships:
            continue
        r, n = spearman([x[key] for x in rows], [x["damage"] for x in rows])
        if math.isfinite(r):
            rs.append(r)
            ns.append(n)
    return float(np.average(rs, weights=ns)) if rs else float("nan")


def report(tag, ships):
    dmg = [s["damage"] for s in ships]
    exp = [s["base_exp"] for s in ships]
    out = {}
    for k in TIE + ["C1"]:
        r_d, n = spearman([s[k] for s in ships], dmg)
        r_x, _ = spearman([s[k] for s in ships], exp)
        out[k] = r_d
        print(
            f"[e20:{tag}] {k}: rho(damage)={r_d:+.4f} rho(baseExp)={r_x:+.4f} n={n}"
        )
    return out


def main():
    explore = load(EXPLORE)
    print(f"[e20] exploration: {len(explore)} ships ({EXPLORE})")
    res = report("explore", explore)
    pos = {k: v for k, v in res.items() if math.isfinite(v) and v > 0}
    if not pos:
        print("[e20] NO positive candidate — honest stop")
        return
    best = max(pos.values())
    tied = [k for k, v in pos.items() if v >= best - 1e-9]
    pick = min(tied, key=lambda k: TIE.index(k) if k in TIE else 99)
    print(f"[e20] PICK {pick} (explore rho {pos[pick]:+.4f}); confirming on {CONFIRM}")
    confirm = load(CONFIRM)
    print(f"[e20] confirmation: {len(confirm)} ships")
    r, n = spearman([s[pick] for s in confirm], [s["damage"] for s in confirm])
    wr = within_rho(confirm, pick)
    print(
        f"[e20] CONFIRM {pick}: rho(damage)={r:+.4f} n={n}; within-replay pooled={wr:+.4f}"
        f" -> {'PASS (rho>=0.30)' if r >= 0.30 else 'FAIL (honest report)'}"
    )


if __name__ == "__main__":
    main()
