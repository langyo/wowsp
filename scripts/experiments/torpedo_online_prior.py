#!/usr/bin/env python3
"""E26e-w: delayed-label / online cell-prior adaptation for the Q3 walk-forward failure.

For each walk-forward test block (Q2/Q3/Q4), launched rows are sorted by battle time t.
The earliest 20% (primary) / 40% (secondary) of launched rows give cell hit-rate estimates
(EB smoothing alpha=20, cell -> mode -> block-global fallback); the remaining 80%/60% are
scored with score = estimated cell prior + eps * within-cell probC rank (rank on eval rows only).

Baselines on the same eval subset:
  raw probC
  oracle: full test-block cell prior (cell n>=5 -> mode -> global) + eval rank (upper bound)
  historical: prior estimated from all blocks strictly before the test block
  rolling: prior estimated from the immediately previous block
No retraining.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from torpedo_outcome_lift import decile_table, top_decile_lift, roc_auc  # noqa: E402

BLOCKS = ("Q1", "Q2", "Q3", "Q4")
RUN_TO_BLOCK = {"runQ2": "Q2", "runQ3": "Q3", "runQ4": "Q4"}
PREV = {"Q2": "Q1", "Q3": "Q2", "Q4": "Q3"}
PRIOR_BLOCKS = {"Q2": ("Q1",), "Q3": ("Q1", "Q2"), "Q4": ("Q1", "Q2", "Q3")}
FRACTIONS = (0.2, 0.4)
EPS = 1e-3
ALPHA = 20.0
MIN_CELL_ROWS = 5
MIN_EVAL_ROWS = 10


def cell_key(game_mode, map_name, ship_class) -> str:
    def norm(v, fallback="unknown"):
        if v is None:
            return fallback
        s = str(v).strip()
        return s if s else fallback
    return norm(game_mode) + "|" + norm(map_name) + "|" + norm(ship_class)


def rank_pct(x) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    if n == 0:
        return np.zeros(0)
    order = np.argsort(x, kind="mergesort")
    ranks = np.empty(n, dtype=np.float64)
    ranks[order] = np.arange(1, n + 1, dtype=np.float64)
    _, inv = np.unique(x, return_inverse=True)
    for g in np.unique(inv):
        m = inv == g
        ranks[m] = ranks[m].mean()
    return ranks / float(n)


def within_group_rank(prob, groups) -> np.ndarray:
    out = np.empty(len(prob), dtype=np.float64)
    groups = np.asarray(groups, dtype=object)
    for g in np.unique(groups):
        m = groups == g
        out[m] = rank_pct(prob[m])
    return out


def score_block(prob, fired, hits) -> dict:
    n = len(prob)
    y = (hits > 0).astype(np.float64)
    base = float(hits.sum() / fired.sum()) if fired.sum() > 0 else None
    table = decile_table(prob, fired, hits)
    lift = top_decile_lift(table, base) if base else None
    order = np.argsort(-prob, kind="mergesort")
    k = max(1, n // 10)
    top = order[:k]
    return {
        "rows": int(n), "firedFish": int(fired.sum()), "hits": int(hits.sum()),
        "baseHitRate": base, "meanScore": float(np.mean(prob)) if n else None,
        "auc": roc_auc(y, prob) if len(np.unique(y)) == 2 else None,
        "topDecileHitRate": float(hits[top].sum() / fired[top].sum()) if fired[top].sum() > 0 else None,
        "topDecileFishLift": lift,
    }


def group_rates(groups, fired, hits) -> dict:
    out = {}
    for g in np.unique(groups):
        m = groups == g
        f = float(fired[m].sum())
        if f > 0:
            out[str(g)] = {"firedFish": f, "hits": float(hits[m].sum()), "rows": int(m.sum()),
                           "baseHitRate": float(hits[m].sum() / f)}
    return out


def smoothed(rates: dict, global_base: float, alpha: float = ALPHA) -> dict:
    out = {}
    for k, v in rates.items():
        out[k] = {"prior": float((v["hits"] + alpha * global_base) / (v["firedFish"] + alpha)),
                  "firedFish": v["firedFish"], "hits": v["hits"], "rows": v["rows"],
                  "baseHitRate": v["baseHitRate"]}
    return out


def resolve(cells, modes, cell_prior: dict, mode_prior: dict, global_prior: float) -> np.ndarray:
    out = np.empty(len(cells), dtype=np.float64)
    covered = np.zeros(len(cells), dtype=bool)
    for i, (c, m) in enumerate(zip(cells, modes)):
        if c in cell_prior:
            out[i] = cell_prior[c]
            covered[i] = True
        elif m in mode_prior:
            out[i] = mode_prior[m]
        else:
            out[i] = global_prior
    return out


def prior_from_blocks(blocks, block_names):
    fired_all, hits_all, cells_all, modes_all = [], [], [], []
    for q in block_names:
        la = launched_arrays(blocks[q])
        fired_all.append(la["fired"])
        hits_all.append(la["hits"])
        cells_all.append(la["cells"])
        modes_all.append(la["modes"])
    if not fired_all or sum(len(x) for x in fired_all) == 0:
        return {"cell": {}, "mode": {}, "global": 0.0, "rows": 0}
    fired = np.concatenate(fired_all)
    hits = np.concatenate(hits_all)
    cells = np.concatenate(cells_all)
    modes = np.concatenate(modes_all)
    gb = float(hits.sum() / fired.sum())
    cp = smoothed(group_rates(cells, fired, hits), gb)
    mp = smoothed(group_rates(modes, fired, hits), gb)
    return {"cell": {k: v["prior"] for k, v in cp.items()},
            "mode": {k: v["prior"] for k, v in mp.items()},
            "global": gb, "rows": int(len(fired)),
            "rawCellRates": group_rates(cells, fired, hits)}


def oracle_priors(la):
    gb = float(la["hits"].sum() / la["fired"].sum())
    cr = group_rates(la["cells"], la["fired"], la["hits"])
    mr = group_rates(la["modes"], la["fired"], la["hits"])
    cp = {k: v["baseHitRate"] for k, v in cr.items() if v["rows"] >= MIN_CELL_ROWS}
    mp = {k: v["baseHitRate"] for k, v in mr.items() if v["rows"] >= MIN_CELL_ROWS}
    return {"cell": cp, "mode": mp, "global": gb, "rawCellRates": cr}


def load_blocks(dataset_path: Path, split_summary: dict, class_of: dict):
    blocks = {q: {"rows": []} for q in BLOCKS}
    block_of_replay = {}
    for q in BLOCKS:
        for rid in split_summary["blocks"][q]["replayIds"]:
            block_of_replay[rid] = q
    n = 0
    with Path(dataset_path).open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            q = block_of_replay.get(row.get("replayId"))
            if q is None:
                continue
            sid = row.get("shipId")
            cls = class_of.get(int(sid), "unknown") if sid is not None else "unknown"
            blocks[q]["rows"].append({
                "gameMode": str(row.get("gameMode")),
                "mapName": str(row.get("mapName")),
                "shipClass": cls,
                "cell": cell_key(row.get("gameMode"), row.get("mapName"), cls),
                "labelB": bool(row.get("labelBLaunched")),
            })
            n += 1
    if n == 0:
        raise SystemExit("[e26w] no dataset rows matched the Q blocks")
    return blocks


def attach_outcomes(blocks: dict, outcome_dir: Path):
    for q in BLOCKS:
        path = outcome_dir / ("outcome_own_block_" + q + ".jsonl")
        if not path.exists():
            raise SystemExit("[e26w] missing " + str(path))
        fired, hits = [], []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                rec = json.loads(line)
                fired.append(int(rec.get("torpFiredFish", 0) or 0))
                hits.append(int(rec.get("torpHits", 0) or 0))
        rows = blocks[q]["rows"]
        if len(fired) != len(rows):
            raise SystemExit("[e26w] outcome rows mismatch for " + q)
        blocks[q]["fired"] = np.asarray(fired, dtype=np.int64)
        blocks[q]["hits"] = np.asarray(hits, dtype=np.int64)
        blocks[q]["modes"] = np.asarray([r["gameMode"] for r in rows], dtype=object)
        blocks[q]["cells"] = np.asarray([r["cell"] for r in rows], dtype=object)
        blocks[q]["labelB"] = np.asarray([r["labelB"] for r in rows], dtype=bool)


def launched_arrays(block):
    mask = block["labelB"] & (block["fired"] >= 1)
    return {"mask": mask, "cells": block["cells"][mask], "modes": block["modes"][mask],
            "fired": block["fired"][mask], "hits": block["hits"][mask]}


def estimate_early(prob, t, row_index, cells, modes, fired, hits, frac: float):
    n = len(prob)
    order = np.lexsort((row_index, t))
    early_n = max(1, int(round(n * frac)))
    if n - early_n < MIN_EVAL_ROWS:
        raise SystemExit("[e26w] eval subset too small")
    early_idx = order[:early_n]
    eval_idx = order[early_n:]
    e = {"fired": fired[early_idx], "hits": hits[early_idx],
         "cells": cells[early_idx], "modes": modes[early_idx]}
    gb = float(e["hits"].sum() / e["fired"].sum()) if e["fired"].sum() > 0 else 0.0
    cell_prior = {k: v["prior"] for k, v in smoothed(group_rates(e["cells"], e["fired"], e["hits"]), gb).items()}
    mode_prior = {k: v["prior"] for k, v in smoothed(group_rates(e["modes"], e["fired"], e["hits"]), gb).items()}
    ev_cells = cells[eval_idx]
    ev_modes = modes[eval_idx]
    prior = resolve(ev_cells, ev_modes, cell_prior, mode_prior, gb)
    within = within_group_rank(prob[eval_idx], ev_cells)
    score = prior + EPS * within
    raw = prob[eval_idx]
    coverage = {
        "earlyRows": int(early_n), "evalRows": int(len(eval_idx)),
        "earlyFired": int(e["fired"].sum()), "evalFired": int(fired[eval_idx].sum()),
        "earlyCells": int(len(np.unique(e["cells"]))),
        "evalCells": int(len(np.unique(ev_cells))),
        "evalRowsCellCovered": int(sum(1 for c in ev_cells if c in cell_prior)),
        "evalRowsModeCoveredOnly": int(sum(1 for c, m in zip(ev_cells, ev_modes)
                                             if c not in cell_prior and m in mode_prior)),
        "evalRowsGlobalOnly": int(sum(1 for c, m in zip(ev_cells, ev_modes)
                                       if c not in cell_prior and m not in mode_prior)),
        "earlyCellRates": {k: round(v["baseHitRate"], 4) for k, v in
                           group_rates(e["cells"], e["fired"], e["hits"]).items()},
        "earlyCellSupport": {k: v["rows"] for k, v in
                              group_rates(e["cells"], e["fired"], e["hits"]).items()},
        "evalModeBase": {str(k): round(v["baseHitRate"], 4) for k, v in
                          group_rates(ev_modes, fired[eval_idx], hits[eval_idx]).items()},
        "earlyModeBase": {str(k): round(v["baseHitRate"], 4) for k, v in
                          group_rates(e["modes"], e["fired"], e["hits"]).items()},
    }
    return {
        "fraction": frac, "earlyN": int(early_n), "evalN": int(len(eval_idx)),
        "earlyGlobalBase": gb, "evalGlobalBase": float(hits[eval_idx].sum() / fired[eval_idx].sum()),
        "score": score_block(score, fired[eval_idx], hits[eval_idx]),
        "raw": score_block(raw, fired[eval_idx], hits[eval_idx]),
        "coverage": coverage,
        "earlyCellPrior": {k: float((v["hits"] + ALPHA * gb) / (v["firedFish"] + ALPHA))
                           for k, v in group_rates(e["cells"], e["fired"], e["hits"]).items()},
    }


def analyze_run(run: str, npz_path: Path, blocks: dict) -> dict:
    test_q = RUN_TO_BLOCK[run]
    block = blocks[test_q]
    z = np.load(npz_path, allow_pickle=False)
    n_block = len(block["cells"])
    if len(z["labelB"]) != n_block:
        raise SystemExit("[e26w] prediction rows != block rows for " + run)
    row_index = z["rowIndex"].astype(np.int64) if "rowIndex" in z.files else np.arange(n_block)
    labelB = z["labelB"].astype(np.float64)
    fired = z["fired"].astype(np.int64)
    hits = z["hits"].astype(np.int64)
    prob = z["probC"].astype(np.float64)
    t = z["t"].astype(np.float64) if "t" in z.files else np.arange(n_block, dtype=np.float64)
    mask = (labelB == 1.0) & (fired >= 1)
    idx_launched = np.flatnonzero(mask)
    cells = block["cells"][row_index[mask]]
    modes = block["modes"][row_index[mask]]
    prob_l = prob[mask]
    fired_l = fired[mask]
    hits_l = hits[mask]
    t_l = t[mask]
    ri_l = row_index[mask]
    la = launched_arrays(block)
    gb = float(hits_l.sum() / fired_l.sum())

    # full-block oracle (upper bound) and historical/rolling priors on eval subset
    ora = oracle_priors({"cells": cells, "modes": modes, "fired": fired_l, "hits": hits_l})
    hist = prior_from_blocks(blocks, PRIOR_BLOCKS[test_q])
    roll = prior_from_blocks(blocks, (PREV[test_q],))

    results = {}
    for frac in FRACTIONS:
        res = estimate_early(prob_l, t_l, ri_l, cells, modes, fired_l, hits_l, frac)
        order = np.lexsort((ri_l, t_l))
        eval_n = max(1, int(round(len(prob_l) * frac)))
        ev = order[eval_n:]
        ev_cells = cells[ev]
        ev_modes = modes[ev]
        ev_fired = fired_l[ev]
        ev_hits = hits_l[ev]
        ev_prob = prob_l[ev]
        within = within_group_rank(ev_prob, ev_cells)
        ora_prior = resolve(ev_cells, ev_modes, ora["cell"], ora["mode"], gb)
        hist_prior = resolve(ev_cells, ev_modes, hist["cell"], hist["mode"], hist["global"])
        roll_prior = resolve(ev_cells, ev_modes, roll["cell"], roll["mode"], roll["global"])
        res["oracleEval"] = score_block(ora_prior + EPS * within, ev_fired, ev_hits)
        res["historicalEval"] = score_block(hist_prior + EPS * within, ev_fired, ev_hits)
        res["rollingEval"] = score_block(roll_prior + EPS * within, ev_fired, ev_hits)
        results[str(frac)] = res

    return {
        "run": run, "testBlock": test_q,
        "launched": int(len(prob_l)), "firedFish": int(fired_l.sum()), "hits": int(hits_l.sum()),
        "baseHitRate": gb,
        "oracleFullCellPrior": {"cells": len(ora["cell"]), "modes": len(ora["mode"]), "global": gb},
        "historical": {"blocks": list(PRIOR_BLOCKS[test_q]), "rows": hist["rows"], "global": hist["global"],
                       "cells": len(hist["cell"]), "modes": len(hist["mode"])},
        "rolling": {"blocks": [PREV[test_q]], "rows": roll["rows"], "global": roll["global"],
                    "cells": len(roll["cell"]), "modes": len(roll["mode"])},
        "fractions": results,
        "oracleRawCellRates": {k: {kk: round(vv, 4) if isinstance(vv, float) else vv
                                   for kk, vv in v.items()} for k, v in ora["rawCellRates"].items()},
    }


def write_markdown(results: dict, path: Path):
    def f(v):
        return "-" if v is None else str(round(v, 4))

    lines = ["# E26e-w delayed-label / online cell-prior adaptation", ""]
    lines.append("Launched rows sorted by t; earliest 20%/40% labels estimate cell priors; eval on the rest.")
    lines.append("")
    lines.append("| run | eval n | raw lift | early20 lift | early40 lift | oracle20 lift | oracle40 lift | hist20 | roll20 |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        a = r["fractions"]["0.2"]
        b = r["fractions"]["0.4"]
        lines.append("| " + run + " | " + str(a["evalN"]) + " | " + f(a["raw"]["topDecileFishLift"]) + " | "
                     + f(a["score"]["topDecileFishLift"]) + " | " + f(b["score"]["topDecileFishLift"]) + " | "
                     + f(a["oracleEval"]["topDecileFishLift"]) + " | " + f(b["oracleEval"]["topDecileFishLift"]) + " | "
                     + f(a["historicalEval"]["topDecileFishLift"]) + " | " + f(a["rollingEval"]["topDecileFishLift"]) + " |")
    lines.append("")
    lines.append("| run | raw AUC | early20 AUC | early40 AUC | oracle20 AUC | oracle40 AUC |")
    lines.append("|---|---|---|---|---|---|")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        a = r["fractions"]["0.2"]
        b = r["fractions"]["0.4"]
        lines.append("| " + run + " | " + f(a["raw"]["auc"]) + " | " + f(a["score"]["auc"]) + " | " + f(b["score"]["auc"])
                     + " | " + f(a["oracleEval"]["auc"]) + " | " + f(b["oracleEval"]["auc"]) + " |")
    lines.append("")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        lines.append("## " + run + " (test " + r["testBlock"] + ", launched " + str(r["launched"]) + ")")
        lines.append("")
        for frac in ("0.2", "0.4"):
            res = r["fractions"][frac]
            cov = res["coverage"]
            lines.append("### early " + frac)
            lines.append("")
            lines.append("early rows " + str(cov["earlyRows"]) + " fired " + str(cov["earlyFired"])
                         + " cells " + str(cov["earlyCells"]) + " | eval rows " + str(cov["evalRows"])
                         + " fired " + str(cov["evalFired"]) + " | covered eval rows: cell "
                         + str(cov["evalRowsCellCovered"]) + ", mode-only " + str(cov["evalRowsModeCoveredOnly"])
                         + ", global-only " + str(cov["evalRowsGlobalOnly"]))
            lines.append("")
            lines.append("early mode base " + json.dumps(cov["earlyModeBase"]) + " | eval mode base "
                         + json.dumps(cov["evalModeBase"]))
            lines.append("")
            lines.append("| metric | raw(eval) | early-prior | oracle(eval) | historical | rolling |")
            lines.append("|---|---|---|---|---|---|")
            for key in ("topDecileFishLift", "auc", "topDecileHitRate", "meanScore"):
                vals = [f(res["raw"][key]), f(res["score"][key]), f(res["oracleEval"][key]),
                        f(res["historicalEval"][key]), f(res["rollingEval"][key])]
                lines.append("| " + key + " | " + " | ".join(vals) + " |")
            lines.append("")
            lines.append("early cell priors (top by fired): " + json.dumps(
                dict(sorted(((k, round(v, 4)) for k, v in res["earlyCellPrior"].items()),
                            key=lambda kv: -cov["earlyCellSupport"].get(kv[0], 0))[:6]), ensure_ascii=False))
            lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    assert cell_key("brawl", "m", "Cruiser") == "brawl|m|Cruiser"
    assert cell_key(None, "", None) == "unknown|unknown|unknown"
    # time ordering
    t = np.array([5.0, 1.0, 3.0, 2.0])
    ri = np.arange(4)
    order = np.lexsort((ri, t))
    assert order.tolist() == [1, 3, 2, 0]
    # EB smoothing
    gb = 0.2
    sm = smoothed({"c": {"firedFish": 0, "hits": 0, "rows": 0, "baseHitRate": 0.0}}, gb)
    assert abs(sm["c"]["prior"] - gb) < 1e-12
    sm2 = smoothed({"c": {"firedFish": 100, "hits": 50, "rows": 10, "baseHitRate": 0.5}}, gb)
    assert abs(sm2["c"]["prior"] - (50 + ALPHA * gb) / (100 + ALPHA)) < 1e-12
    # fallback resolution
    prior = resolve(np.array(["c1", "c2", "c3"], dtype=object), np.array(["m1", "m1", "m2"], dtype=object),
                    {"c1": 0.5}, {"m1": 0.3}, 0.1)
    assert prior[0] == 0.5 and prior[1] == 0.3 and prior[2] == 0.1
    # rank determinism
    x = np.array([0.1, 0.5, 0.5, 0.9])
    r = rank_pct(x)
    assert np.allclose(r, rank_pct(x)) and np.all(r > 0) and np.all(r <= 1)
    # metrics sanity
    fired = np.full(20, 5, dtype=np.int64)
    hits = np.array([0] * 10 + [1] * 10, dtype=np.int64)
    prob = np.concatenate([np.linspace(0.0, 0.4, 10), np.linspace(0.6, 1.0, 10)])
    met = score_block(prob, fired, hits)
    assert met["auc"] > 0.9 and met["topDecileFishLift"] > 1.0, met
    # early estimator picks earliest rows and leaves enough eval
    n = 100
    cells = np.array(["a"] * 50 + ["b"] * 50, dtype=object)
    modes = cells
    prob = np.linspace(0.1, 0.9, n)
    t = np.arange(n, dtype=np.float64)
    fired = np.full(n, 4, dtype=np.int64)
    hits = np.array([0] * 10 + [1] * 40 + [0] * 10 + [1] * 40, dtype=np.int64)
    res = estimate_early(prob, t, np.arange(n), cells, modes, fired, hits, 0.2)
    assert res["earlyN"] == 20 and res["evalN"] == 80, res
    assert res["coverage"]["earlyCells"] == 1
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-w delayed-label online cell prior")
    ap.add_argument("--runs-dir", default="")
    ap.add_argument("--split-summary", default="")
    ap.add_argument("--dataset", default="")
    ap.add_argument("--ships", default="")
    ap.add_argument("--outcome-dir", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("runs_dir", "split_summary", "dataset", "ships", "outcome_dir", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26w] missing arguments: " + ", ".join(missing))
    ships = json.loads(Path(args.ships).read_text(encoding="utf-8"))
    class_of = {}
    for sid, info in ships.get("ships", {}).items():
        if isinstance(info, dict) and info.get("type"):
            class_of[int(sid)] = str(info["type"])
    split = json.loads(Path(args.split_summary).read_text(encoding="utf-8"))
    blocks = load_blocks(Path(args.dataset), split, class_of)
    attach_outcomes(blocks, Path(args.outcome_dir))
    results = {}
    for run in ("runQ2", "runQ3", "runQ4"):
        results[run] = analyze_run(run, Path(args.runs_dir) / run / "holdout_ensemble.npz", blocks)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_lineage": "E26e-w delayed-label / online cell-prior adaptation (descriptive; no retraining)",
               "fractions": list(FRACTIONS), "alpha": ALPHA, "minCellRows": MIN_CELL_ROWS,
               "results": results}
    (out_dir / "online_prior.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False) + chr(10), encoding="utf-8")
    write_markdown(results, out_dir / "online_prior_report.md")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        a = r["fractions"]["0.2"]
        b = r["fractions"]["0.4"]
        print("[e26w] " + run + " " + r["testBlock"] + " launched " + str(r["launched"])
              + " | raw(eval) " + str(round(a["raw"]["topDecileFishLift"], 4))
              + " early20 " + str(round(a["score"]["topDecileFishLift"], 4)) + " AUC " + str(round(a["score"]["auc"], 4))
              + " | early40 " + str(round(b["score"]["topDecileFishLift"], 4)) + " AUC " + str(round(b["score"]["auc"], 4))
              + " | oracle20 " + str(round(a["oracleEval"]["topDecileFishLift"], 4))
              + " oracle40 " + str(round(b["oracleEval"]["topDecileFishLift"], 4))
              + " | hist20 " + str(round(a["historicalEval"]["topDecileFishLift"], 4))
              + " roll20 " + str(round(a["rollingEval"]["topDecileFishLift"], 4)))
    print("[e26w] summary -> " + str(out_dir / "online_prior.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
