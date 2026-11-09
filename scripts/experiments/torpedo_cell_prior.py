#!/usr/bin/env python3
"""E26e-v: multi-level cell prior + historical/rolling label-free priors for Q3 (no retraining).

cell = gameMode|mapName|shipClass (missing -> unknown).
For each walk-forward test block (Q2/Q3/Q4) on launched rows we compare:
  raw                 probC as delivered
  oracle_cell         test-block cell base (n>=5, else mode, else global) + eps*within-cell rank
  historical_cell     cell base from ALL blocks strictly before the test block (EB smoothing alpha=20),
                      missing -> smoothed mode prior -> global prior; + eps*within-cell rank
  rolling_cell        same, but only the immediately previous block
  within_cell         within-cell percentile rank only (no prior)
  oracle_mode / hist_mode  mode-level controls (E26e-u style)
Outputs a JSON + markdown report under out/torpedo_model/e26e-v/.
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
PRIOR_BLOCKS = {
    "Q2": ("Q1",),
    "Q3": ("Q1", "Q2"),
    "Q4": ("Q1", "Q2", "Q3"),
}
EPS = 1e-3
ALPHA = 20.0
MIN_CELL_ROWS = 5


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


def write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + chr(10), encoding="utf-8")


def cell_key(game_mode, map_name, ship_class) -> str:
    def norm(v, fallback="unknown"):
        if v is None:
            return fallback
        s = str(v).strip()
        return s if s else fallback
    return norm(game_mode) + "|" + norm(map_name) + "|" + norm(ship_class)


def group_rates(launched, fired, hits):
    out = {}
    for g in np.unique(launched):
        m = launched == g
        f = float(fired[m].sum())
        if f > 0:
            out[str(g)] = {"firedFish": f, "hits": float(hits[m].sum()),
                           "rows": int(m.sum()), "baseHitRate": float(hits[m].sum() / f)}
    return out


def smoothed_prior(rates: dict, global_base: float, alpha: float = ALPHA) -> dict:
    out = {}
    for k, v in rates.items():
        out[k] = {"prior": float((v["hits"] + alpha * global_base) / (v["firedFish"] + alpha)),
                  "firedFish": v["firedFish"], "hits": v["hits"], "rows": v["rows"],
                  "baseHitRate": v["baseHitRate"]}
    return out


def resolve_prior(cells, modes, cell_prior: dict, mode_prior: dict, global_prior: float) -> np.ndarray:
    out = np.empty(len(cells), dtype=np.float64)
    for i, (c, m) in enumerate(zip(cells, modes)):
        if c in cell_prior:
            out[i] = cell_prior[c]
        elif m in mode_prior:
            out[i] = mode_prior[m]
        else:
            out[i] = global_prior
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


def per_cell_stats(prob, cells, modes, fired, hits, min_rows: int = 1) -> dict:
    out = {}
    for c in np.unique(cells):
        m = cells == c
        if int(m.sum()) < min_rows or fired[m].sum() <= 0:
            continue
        f = fired[m]
        h = hits[m]
        base = float(h.sum() / f.sum())
        entry = {
            "rows": int(m.sum()), "firedFish": int(f.sum()), "hits": int(h.sum()),
            "baseHitRate": base, "meanProbC": float(prob[m].mean()),
            "modes": sorted(set(str(x) for x in np.unique(modes[m]))),
            "topDecileFishLift": None,
        }
        if f.sum() >= 50:
            tab = decile_table(prob[m], f, h)
            entry["topDecileFishLift"] = top_decile_lift(tab, base)
        out[str(c)] = entry
    return out


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
        raise SystemExit("[e26v] no dataset rows matched the Q blocks")
    for q in BLOCKS:
        path = None
        blocks[q]["fired"] = None
    return blocks


def attach_outcomes(blocks: dict, outcome_dir: Path):
    for q in BLOCKS:
        path = outcome_dir / ("outcome_own_block_" + q + ".jsonl")
        if not path.exists():
            raise SystemExit("[e26v] missing " + str(path))
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
            raise SystemExit("[e26v] outcome rows mismatch for " + q)
        blocks[q]["fired"] = np.asarray(fired, dtype=np.int64)
        blocks[q]["hits"] = np.asarray(hits, dtype=np.int64)
        blocks[q]["modes"] = np.asarray([r["gameMode"] for r in rows], dtype=object)
        blocks[q]["cells"] = np.asarray([r["cell"] for r in rows], dtype=object)
        blocks[q]["labelB"] = np.asarray([r["labelB"] for r in rows], dtype=bool)


def launched_arrays(block):
    mask = block["labelB"] & (block["fired"] >= 1)
    return {
        "mask": mask,
        "cells": block["cells"][mask],
        "modes": block["modes"][mask],
        "fired": block["fired"][mask],
        "hits": block["hits"][mask],
    }


def prior_from_blocks(blocks, block_names, global_prior=None):
    fired_all, hits_all, cells_all, modes_all = [], [], [], []
    for q in block_names:
        la = launched_arrays(blocks[q])
        fired_all.append(la["fired"])
        hits_all.append(la["hits"])
        cells_all.append(la["cells"])
        modes_all.append(la["modes"])
    if not fired_all or sum(len(x) for x in fired_all) == 0:
        gb = 0.0
        return {"cell": {}, "mode": {}, "global": gb, "rows": 0}
    fired = np.concatenate(fired_all)
    hits = np.concatenate(hits_all)
    cells = np.concatenate(cells_all)
    modes = np.concatenate(modes_all)
    gb = float(hits.sum() / fired.sum())
    cell_rates = group_rates(cells, fired, hits)
    mode_rates = group_rates(modes, fired, hits)
    cell_prior = smoothed_prior(cell_rates, gb)
    mode_prior = smoothed_prior(mode_rates, gb)
    return {
        "cell": {k: v["prior"] for k, v in cell_prior.items()},
        "mode": {k: v["prior"] for k, v in mode_prior.items()},
        "cellRates": cell_rates, "modeRates": mode_rates,
        "global": gb, "rows": int(len(fired)),
    }


def oracle_priors(la):
    gb = float(la["hits"].sum() / la["fired"].sum())
    cell_rates = group_rates(la["cells"], la["fired"], la["hits"])
    mode_rates = group_rates(la["modes"], la["fired"], la["hits"])
    cell_prior = {}
    for k, v in cell_rates.items():
        if v["rows"] >= MIN_CELL_ROWS:
            cell_prior[k] = v["baseHitRate"]
    mode_prior = {}
    for k, v in mode_rates.items():
        if v["rows"] >= MIN_CELL_ROWS:
            mode_prior[k] = v["baseHitRate"]
    return {"cell": cell_prior, "mode": mode_prior, "global": gb,
            "cellRates": cell_rates, "modeRates": mode_rates}


def analyze_run(run: str, npz_path: Path, blocks: dict) -> dict:
    test_q = RUN_TO_BLOCK[run]
    block = blocks[test_q]
    z = np.load(npz_path, allow_pickle=False)
    n_block = len(block["cells"])
    if len(z["labelB"]) != n_block:
        raise SystemExit("[e26v] prediction rows != block rows for " + run)
    row_index = z["rowIndex"].astype(np.int64) if "rowIndex" in z.files else np.arange(n_block)
    labelB = z["labelB"].astype(np.float64)
    fired = z["fired"].astype(np.int64)
    hits = z["hits"].astype(np.int64)
    prob = z["probC"].astype(np.float64)
    mask = (labelB == 1.0) & (fired >= 1)
    cells = block["cells"][row_index[mask]]
    modes = block["modes"][row_index[mask]]
    fired_l = fired[mask]
    hits_l = hits[mask]
    prob_l = prob[mask]
    gb = float(hits_l.sum() / fired_l.sum())

    within_cell = within_group_rank(prob_l, cells)
    within_mode = within_group_rank(prob_l, modes)

    ora = oracle_priors({"cells": cells, "modes": modes, "fired": fired_l, "hits": hits_l})
    ora_prior = resolve_prior(cells, modes, ora["cell"], ora["mode"], gb)
    ora_mode_prior = resolve_prior(modes, modes, ora["mode"], {}, gb)
    hist = prior_from_blocks(blocks, PRIOR_BLOCKS[test_q])
    hist_prior = resolve_prior(cells, modes, hist["cell"], hist["mode"], hist["global"])
    hist_mode_prior = resolve_prior(modes, modes, hist["mode"], {}, hist["global"])
    roll = prior_from_blocks(blocks, (PREV[test_q],))
    roll_prior = resolve_prior(cells, modes, roll["cell"], roll["mode"], roll["global"])
    roll_mode_prior = resolve_prior(modes, modes, roll["mode"], {}, roll["global"])

    def sc(score):
        return score_block(score, fired_l, hits_l)

    coverage = {
        "cells": int(len(np.unique(cells))),
        "cellsWithAtLeast5Rows": int(sum(1 for v in ora["cellRates"].values() if v["rows"] >= MIN_CELL_ROWS)),
        "launchedRowsInCellsWithAtLeast5": int(sum(v["rows"] for v in ora["cellRates"].values() if v["rows"] >= MIN_CELL_ROWS)),
        "launchedRows": int(len(cells)),
    }

    result = {
        "run": run, "testBlock": test_q,
        "rows": int(len(prob_l)), "firedFish": int(fired_l.sum()), "hits": int(hits_l.sum()),
        "baseHitRate": gb,
        "raw": sc(prob_l),
        "withinCell": sc(within_cell),
        "oracleCell": sc(ora_prior + EPS * within_cell),
        "historicalCell": sc(hist_prior + EPS * within_cell),
        "rollingCell": sc(roll_prior + EPS * within_cell),
        "oracleMode": sc(ora_mode_prior + EPS * within_mode),
        "historicalMode": sc(hist_mode_prior + EPS * within_mode),
        "coverage": coverage,
        "perCellRaw": per_cell_stats(prob_l, cells, modes, fired_l, hits_l, min_rows=MIN_CELL_ROWS),
        "oracleCellRates": ora["cellRates"],
        "oracleModeRates": ora["modeRates"],
        "historicalPrior": {
            "blocks": list(PRIOR_BLOCKS[test_q]), "globalBase": hist["global"],
            "rows": hist["rows"], "cellsWithPrior": len(hist["cell"]), "modesWithPrior": len(hist["mode"]),
            "missingTestCells": sorted(set(str(c) for c in np.unique(cells)) - set(hist["cell"])),
        },
        "rollingPrior": {
            "blocks": [PREV[test_q]], "globalBase": roll["global"], "rows": roll["rows"],
            "cellsWithPrior": len(roll["cell"]), "modesWithPrior": len(roll["mode"]),
            "missingTestCells": sorted(set(str(c) for c in np.unique(cells)) - set(roll["cell"])),
        },
    }
    return result


def write_markdown(results: dict, path: Path):
    def f(v):
        return "-" if v is None else str(round(v, 4))

    lines = ["# E26e-v multi-level cell prior / historical prior", ""]
    lines.append("Launched-row global headC metrics (official outcome_lift decile lift). cell = gameMode|mapName|shipClass.")
    lines.append("")
    lines.append("| run | raw | within-cell | oracle-cell | historical-cell | rolling-cell | oracle-mode | historical-mode |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        lines.append("| " + run + " | " + " | ".join(f(r[k]["topDecileFishLift"]) for k in
                     ("raw", "withinCell", "oracleCell", "historicalCell", "rollingCell", "oracleMode", "historicalMode")) + " |")
    lines.append("")
    lines.append("| run | raw AUC | within-cell AUC | oracle-cell AUC | historical AUC | rolling AUC |")
    lines.append("|---|---|---|---|---|---|")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        lines.append("| " + run + " | " + " | ".join(f(r[k]["auc"]) for k in
                     ("raw", "withinCell", "oracleCell", "historicalCell", "rollingCell")) + " |")
    lines.append("")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        lines.append("## " + run + " (test " + r["testBlock"] + ")")
        lines.append("")
        cov = r["coverage"]
        lines.append("rows " + str(r["rows"]) + " fired " + str(r["firedFish"]) + " hits " + str(r["hits"])
                     + " base " + f(r["baseHitRate"]) + " | cells " + str(cov["cells"])
                     + " (n>=5: " + str(cov["cellsWithAtLeast5Rows"]) + ", rows covered "
                     + str(cov["launchedRowsInCellsWithAtLeast5"]) + "/" + str(cov["launchedRows"]) + ")")
        lines.append("")
        lines.append("| mode/cell prior | rows used | cells | modes | missing test cells |")
        lines.append("|---|---|---|---|---|")
        hp = r["historicalPrior"]
        lines.append("| historical " + "-".join(hp["blocks"]) + " | " + str(hp["rows"]) + " | " + str(hp["cellsWithPrior"])
                     + " | " + str(hp["modesWithPrior"]) + " | " + str(hp["missingTestCells"]) + " |")
        rp = r["rollingPrior"]
        lines.append("| rolling " + rp["blocks"][0] + " | " + str(rp["rows"]) + " | " + str(rp["cellsWithPrior"])
                     + " | " + str(rp["modesWithPrior"]) + " | " + str(rp["missingTestCells"]) + " |")
        lines.append("")
        lines.append("| cell | rows | fired | hits | base | meanProbC | lift(raw) | oracle cell base |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for c, v in r["perCellRaw"].items():
            ob = r["oracleCellRates"].get(c, {}).get("baseHitRate")
            lines.append("| " + c + " | " + str(v["rows"]) + " | " + str(v["firedFish"]) + " | " + str(v["hits"])
                         + " | " + f(v["baseHitRate"]) + " | " + f(v["meanProbC"]) + " | " + f(v["topDecileFishLift"])
                         + " | " + f(ob) + " |")
        lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    assert cell_key("pvp", "map", "Cruiser") == "pvp|map|Cruiser"
    assert cell_key(None, "", None) == "unknown|unknown|unknown"
    # smoothing: empty cell prior -> global; large cell -> close to raw base
    gb = 0.2
    sm = smoothed_prior({"a": {"firedFish": 0, "hits": 0, "rows": 0, "baseHitRate": 0.0}}, gb, alpha=20)
    assert abs(sm["a"]["prior"] - gb) < 1e-12, sm
    sm2 = smoothed_prior({"a": {"firedFish": 200, "hits": 100, "rows": 10, "baseHitRate": 0.5}}, gb, alpha=20)
    assert abs(sm2["a"]["prior"] - (100 + 20 * gb) / (200 + 20)) < 1e-12
    # fallback resolution: cell -> mode -> global
    prior = resolve_prior(np.array(["c1", "c2", "c3"], dtype=object),
                          np.array(["m1", "m1", "m2"], dtype=object),
                          {"c1": 0.5}, {"m1": 0.3}, 0.1)
    assert abs(prior[0] - 0.5) < 1e-12 and abs(prior[1] - 0.3) < 1e-12 and abs(prior[2] - 0.1) < 1e-12
    # rank determinism and range
    x = np.array([0.1, 0.5, 0.5, 0.9])
    r = rank_pct(x)
    assert np.all(r > 0) and np.all(r <= 1) and r[0] < r[1] == r[2] < r[3]
    assert np.allclose(r, rank_pct(x))
    # within-group rank: groups independent
    groups = np.array(["a", "a", "b", "b"], dtype=object)
    wr = within_group_rank(np.array([0.2, 0.8, 0.1, 0.9]), groups)
    assert wr[1] > wr[0] and wr[3] > wr[2]
    # cell prior dominates eps rank when bases differ
    score = resolve_prior(np.array(["c1", "c2"], dtype=object),
                          np.array(["m", "m"], dtype=object),
                          {"c1": 0.1, "c2": 0.4}, {}, 0.2) + EPS * np.array([0.0, 1.0])
    assert score[1] > score[0]
    # metrics sanity
    fired = np.full(20, 5, dtype=np.int64)
    hits = np.array([0] * 10 + [1] * 10, dtype=np.int64)
    prob = np.concatenate([np.linspace(0.0, 0.4, 10), np.linspace(0.6, 1.0, 10)])
    met = score_block(prob, fired, hits)
    assert met["auc"] is not None and met["auc"] > 0.9, met
    assert met["topDecileFishLift"] is not None and met["topDecileFishLift"] > 1.0
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-v cell prior / historical prior")
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
        raise SystemExit("[e26v] missing arguments: " + ", ".join(missing))
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
    payload = {"_lineage": "E26e-v multi-level cell prior / historical label-free prior (descriptive; no retraining)",
               "cellDefinition": "gameMode|mapName|shipClass", "alpha": ALPHA, "minCellRows": MIN_CELL_ROWS,
               "results": results}
    write_json(out_dir / "cell_prior.json", payload)
    write_markdown(results, out_dir / "cell_prior_report.md")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        print("[e26v] " + run + " " + r["testBlock"] + " raw " + str(round(r["raw"]["topDecileFishLift"], 4))
              + " within-cell " + str(round(r["withinCell"]["topDecileFishLift"], 4))
              + " oracle-cell " + str(round(r["oracleCell"]["topDecileFishLift"], 4))
              + " historical " + str(round(r["historicalCell"]["topDecileFishLift"], 4))
              + " rolling " + str(round(r["rollingCell"]["topDecileFishLift"], 4))
              + " | AUC raw " + str(round(r["raw"]["auc"], 4))
              + " oracle " + str(round(r["oracleCell"]["auc"], 4))
              + " hist " + str(round(r["historicalCell"]["auc"], 4))
              + " roll " + str(round(r["rollingCell"]["auc"], 4))
              + " | cells " + str(r["coverage"]["cells"]) + " n>=5 " + str(r["coverage"]["cellsWithAtLeast5Rows"]))
    print("[e26v] summary -> " + str(out_dir / "cell_prior.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
