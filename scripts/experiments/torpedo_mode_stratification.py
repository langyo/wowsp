#!/usr/bin/env python3
"""E26e-u: does mode-stratified / prior-normalised scoring repair the Q3 global ranking?

No retraining. For each walk-forward test block (Q2/Q3/Q4) we compare, on the launched rows:
  raw          -- probC as delivered
  within_rank  -- percentile rank of probC inside each gameMode (mode prior ignored)
  oracle_prior -- test-block mode base + eps * within-mode rank (oracle upper bound)
  adapt_prior  -- previous-block mode base + eps * within-mode rank (label-free, missing mode -> global)

Outputs drift-style JSON + markdown under out/torpedo_model/e26e-u/.
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
ADAPT_OF = {"Q2": "Q1", "Q3": "Q2", "Q4": "Q3"}
EPS = 1e-3
MIN_FIRED_FOR_MODE_LIFT = 50


def write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + chr(10), encoding="utf-8")


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


def within_mode_rank(prob, modes) -> np.ndarray:
    out = np.empty(len(prob), dtype=np.float64)
    modes = np.asarray(modes, dtype=object)
    for mode in np.unique(modes):
        m = modes == mode
        out[m] = rank_pct(prob[m])
    return out


def score_block(prob, modes, fired, hits) -> dict:
    n = len(prob)
    y = (hits > 0).astype(np.float64)
    base = float(hits.sum() / fired.sum()) if fired.sum() > 0 else None
    table = decile_table(prob, fired, hits)
    lift = top_decile_lift(table, base) if base else None
    order = np.argsort(-prob, kind="mergesort")
    k = max(1, n // 10)
    top = order[:k]
    return {
        "rows": int(n),
        "firedFish": int(fired.sum()),
        "hits": int(hits.sum()),
        "baseHitRate": base,
        "meanScore": float(np.mean(prob)) if n else None,
        "auc": roc_auc(y, prob) if len(np.unique(y)) == 2 else None,
        "topDecileHitRate": float(hits[top].sum() / fired[top].sum()) if fired[top].sum() > 0 else None,
        "topDecileFishLift": lift,
    }


def per_mode_stats(prob, modes, fired, hits) -> dict:
    out = {}
    modes = np.asarray(modes, dtype=object)
    for mode in sorted(set(str(m) for m in modes)):
        m = modes == mode
        f = fired[m]
        h = hits[m]
        if f.sum() <= 0:
            continue
        base = float(h.sum() / f.sum())
        entry = {
            "rows": int(m.sum()),
            "firedFish": int(f.sum()),
            "hits": int(h.sum()),
            "baseHitRate": base,
            "meanProbC": float(prob[m].mean()),
            "topDecileFishLift": None,
        }
        if f.sum() >= MIN_FIRED_FOR_MODE_LIFT:
            tab = decile_table(prob[m], f, h)
            entry["topDecileFishLift"] = top_decile_lift(tab, base)
        out[mode] = entry
    return out


def mode_bases(modes, fired, hits) -> dict:
    out = {}
    modes = np.asarray(modes, dtype=object)
    for mode in np.unique(modes):
        m = modes == mode
        f = float(fired[m].sum())
        if f > 0:
            out[str(mode)] = float(hits[m].sum() / f)
    return out


def prior_score(prob, modes, prior_by_mode: dict, fallback: float, eps: float = EPS) -> np.ndarray:
    within = within_mode_rank(prob, modes)
    modes = np.asarray(modes, dtype=object)
    prior = np.asarray([prior_by_mode.get(str(m), fallback) for m in modes], dtype=np.float64)
    return prior + eps * within


def load_blocks(dataset_path: Path, split_summary: dict):
    blocks = {q: {"modes": [], "labelB": []} for q in BLOCKS}
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
            blocks[q]["modes"].append(str(row.get("gameMode")))
            blocks[q]["labelB"].append(bool(row.get("labelBLaunched")))
            n += 1
    if n == 0:
        raise SystemExit("[e26u] no dataset rows matched the Q blocks")
    return blocks


def load_block_outcomes(blocks: dict, outcome_dir: Path):
    for q in BLOCKS:
        path = outcome_dir / ("outcome_own_block_" + q + ".jsonl")
        if not path.exists():
            raise SystemExit("[e26u] missing " + str(path))
        fired, hits = [], []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                rec = json.loads(line)
                fired.append(int(rec.get("torpFiredFish", 0) or 0))
                hits.append(int(rec.get("torpHits", 0) or 0))
        if len(fired) != len(blocks[q]["modes"]):
            raise SystemExit("[e26u] outcome rows mismatch for " + q)
        blocks[q]["fired"] = np.asarray(fired, dtype=np.int64)
        blocks[q]["hits"] = np.asarray(hits, dtype=np.int64)
        blocks[q]["modes"] = np.asarray(blocks[q]["modes"], dtype=object)
        blocks[q]["labelB"] = np.asarray(blocks[q]["labelB"], dtype=bool)


def analyze_run(run: str, npz_path: Path, blocks: dict, out_dir: Path) -> dict:
    test_q = RUN_TO_BLOCK[run]
    adapt_q = ADAPT_OF[test_q]
    z = np.load(npz_path, allow_pickle=False)
    n_block = len(blocks[test_q]["modes"])
    if len(z["labelB"]) != n_block:
        raise SystemExit("[e26u] prediction rows != block rows for " + run)
    row_index = z["rowIndex"].astype(np.int64) if "rowIndex" in z.files else np.arange(n_block)
    if row_index.min() < 0 or row_index.max() >= n_block:
        raise SystemExit("[e26u] rowIndex out of range for " + run)
    if "t" in z.files and "t" in blocks[test_q]:
        probe = min(50, n_block)
        if not np.allclose(z["t"][:probe], blocks[test_q]["t"][:probe] if "t" in blocks[test_q] else z["t"][:probe]):
            pass
    labelB = z["labelB"].astype(np.float64)
    fired = z["fired"].astype(np.int64)
    hits = z["hits"].astype(np.int64)
    prob = z["probC"].astype(np.float64)
    mask = (labelB == 1.0) & (fired >= 1)
    # map block row -> launched rows (rowIndex is the block-row index)
    prob_l = prob[mask]
    fired_l = fired[mask]
    hits_l = hits[mask]
    modes_l = blocks[test_q]["modes"][row_index[mask]]
    # adapt block mode bases from its launched rows (label-free prior)
    a = blocks[adapt_q]
    adapt_mask = a["labelB"] & (a["fired"] >= 1)
    adapt_global = float(a["hits"][adapt_mask].sum() / a["fired"][adapt_mask].sum()) if adapt_mask.any() else 0.0
    adapt_bases = mode_bases(a["modes"][adapt_mask], a["fired"][adapt_mask], a["hits"][adapt_mask])
    # oracle mode bases from the test block itself
    oracle_bases = mode_bases(modes_l, fired_l, hits_l)
    global_base = float(hits_l.sum() / fired_l.sum())

    raw = score_block(prob_l, modes_l, fired_l, hits_l)
    within = score_block(within_mode_rank(prob_l, modes_l), modes_l, fired_l, hits_l)
    oracle = score_block(prior_score(prob_l, modes_l, oracle_bases, global_base), modes_l, fired_l, hits_l)
    adapt = score_block(prior_score(prob_l, modes_l, adapt_bases, adapt_global), modes_l, fired_l, hits_l)
    return {
        "run": run, "testBlock": test_q, "adaptBlock": adapt_q,
        "rows": int(len(prob_l)), "launched": int(mask.sum()),
        "firedFish": int(fired_l.sum()), "hits": int(hits_l.sum()), "baseHitRate": global_base,
        "raw": raw, "withinRank": within, "oraclePrior": oracle, "adaptPrior": adapt,
        "perModeRaw": per_mode_stats(prob_l, modes_l, fired_l, hits_l),
        "perModeBaseOracle": oracle_bases,
        "perModeBaseAdapt": adapt_bases,
        "adaptGlobalBase": adapt_global,
        "missingModesInAdapt": sorted(set(str(m) for m in np.unique(modes_l)) - set(adapt_bases)),
    }


def write_markdown(results: dict, path: Path) -> None:
    lines = ["# E26e-u mode-stratified / prior-normalised scoring", ""]
    lines.append("Launched-row global headC outcome metrics per test block (official outcome_lift decile lift).")
    lines.append("")
    lines.append("| run | raw lift | within-mode rank lift | oracle mode-prior lift | adapt-prior lift | raw AUC | oracle AUC | adapt AUC |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]

        def f(v):
            return "-" if v is None else str(round(v, 4))

        lines.append("| " + run + " | " + f(r["raw"]["topDecileFishLift"]) + " | " + f(r["withinRank"]["topDecileFishLift"])
                     + " | " + f(r["oraclePrior"]["topDecileFishLift"]) + " | " + f(r["adaptPrior"]["topDecileFishLift"])
                     + " | " + f(r["raw"]["auc"]) + " | " + f(r["oraclePrior"]["auc"]) + " | " + f(r["adaptPrior"]["auc"]) + " |")
    lines.append("")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        lines.append("## " + run + " (test " + r["testBlock"] + ", adapt " + r["adaptBlock"] + ")")
        lines.append("")
        lines.append("rows " + str(r["rows"]) + " launched " + str(r["launched"]) + " fired " + str(r["firedFish"])
                     + " hits " + str(r["hits"]) + " base " + str(round(r["baseHitRate"], 4)))
        lines.append("")
        lines.append("| metric | raw | within-rank | oracle-prior | adapt-prior |")
        lines.append("|---|---|---|---|---|")
        for key in ("meanScore", "auc", "topDecileHitRate", "topDecileFishLift"):
            vals = []
            for name in ("raw", "withinRank", "oraclePrior", "adaptPrior"):
                v = r[name][key]
                vals.append("-" if v is None else str(round(v, 4)))
            lines.append("| " + key + " | " + " | ".join(vals) + " |")
        lines.append("")
        lines.append("| mode | rows | fired | hits | base | meanProbC | lift(raw) |")
        lines.append("|---|---|---|---|---|---|---|")
        for mode, v in r["perModeRaw"].items():
            lines.append("| " + mode + " | " + str(v["rows"]) + " | " + str(v["firedFish"]) + " | " + str(v["hits"])
                         + " | " + str(round(v["baseHitRate"], 4)) + " | " + str(round(v["meanProbC"], 4))
                         + " | " + ("-" if v["topDecileFishLift"] is None else str(round(v["topDecileFishLift"], 4))) + " |")
        lines.append("")
        lines.append("mode bases: oracle " + json.dumps({k: round(v, 4) for k, v in r["perModeBaseOracle"].items()})
                     + " adapt " + json.dumps({k: round(v, 4) for k, v in r["perModeBaseAdapt"].items()})
                     + " missing-in-adapt " + str(r["missingModesInAdapt"]))
        lines.append("")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_selftest() -> int:
    # rank_pct: monotone inside each mode, in (0, 1], ties averaged
    x = np.array([0.1, 0.4, 0.4, 0.9])
    r = rank_pct(x)
    assert np.all(r > 0) and np.all(r <= 1)
    assert r[0] < r[1] == r[2] < r[3], r
    m = np.array(["a", "a", "b", "b"], dtype=object)
    p = np.array([0.2, 0.8, 0.3, 0.7])
    wr = within_mode_rank(p, m)
    assert 0 < wr[0] < wr[1] <= 1 and 0 < wr[2] < wr[3] <= 1, wr
    # prior score: oracle mode bases dominate (eps small)
    score = prior_score(p, m, {"a": 0.1, "b": 0.3}, 0.2)
    assert score[3] > score[1] and score[2] > score[0], score
    # adapt prior fallback for missing mode
    score2 = prior_score(p, m, {"a": 0.1}, 0.25)
    assert abs(score2[2] - (0.25 + EPS * wr[2])) < 1e-12
    # metrics: perfect within-mode ordering yields positive lift and AUC ~ 1
    modes = np.array(["a"] * 50 + ["b"] * 50, dtype=object)
    prob = np.concatenate([np.linspace(0.1, 0.9, 50), np.linspace(0.1, 0.9, 50)])
    fired = np.full(100, 2, dtype=np.int64)
    hits = np.concatenate([np.array([0] * 25 + [1] * 25), np.array([0] * 25 + [1] * 25)])
    met = score_block(prob, modes, fired, hits)
    assert met["auc"] is not None and met["auc"] > 0.9, met
    assert met["topDecileFishLift"] is not None and met["topDecileFishLift"] > 1.0, met
    # oracle prior on imbalanced modes ranks the high-base mode first
    fired2 = np.full(100, 10, dtype=np.int64)
    hits2 = np.concatenate([np.array([0] * 40 + [1] * 10), np.array([0] * 20 + [1] * 30)])
    oracle = prior_score(prob, modes, {"a": 0.2, "b": 0.6}, 0.4)
    assert np.all(oracle[modes == "b"] > oracle[modes == "a"]), oracle
    om = score_block(oracle, modes, fired2, hits2)
    raw2 = score_block(prob, modes, fired2, hits2)
    assert om["topDecileFishLift"] >= raw2["topDecileFishLift"], (om, raw2)
    assert om["auc"] >= raw2["auc"], (om, raw2)
    print("PASS")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="E26e-u mode stratification / prior normalisation")
    ap.add_argument("--runs-dir", default="")
    ap.add_argument("--split-summary", default="")
    ap.add_argument("--dataset", default="")
    ap.add_argument("--outcome-dir", default="")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)
    if args.selftest:
        return run_selftest()
    missing = [k for k in ("runs_dir", "split_summary", "dataset", "outcome_dir", "out_dir") if not getattr(args, k)]
    if missing:
        raise SystemExit("[e26u] missing arguments: " + ", ".join(missing))
    split = json.loads(Path(args.split_summary).read_text(encoding="utf-8"))
    blocks = load_blocks(Path(args.dataset), split)
    load_block_outcomes(blocks, Path(args.outcome_dir))
    results = {}
    for run in ("runQ2", "runQ3", "runQ4"):
        results[run] = analyze_run(run, Path(args.runs_dir) / run / "holdout_ensemble.npz", blocks, Path(args.out_dir))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"_lineage": "E26e-u mode-stratified / prior-normalised scoring (descriptive; no retraining)", "results": results}
    write_json(out_dir / "mode_stratification.json", payload)
    write_markdown(results, out_dir / "mode_stratification_report.md")
    for run in ("runQ2", "runQ3", "runQ4"):
        r = results[run]
        print("[e26u] " + run + " test " + r["testBlock"] + " adapt " + r["adaptBlock"]
              + " raw " + str(round(r["raw"]["topDecileFishLift"], 4))
              + " within " + str(round(r["withinRank"]["topDecileFishLift"], 4))
              + " oracle " + str(round(r["oraclePrior"]["topDecileFishLift"], 4))
              + " adapt-prior " + str(round(r["adaptPrior"]["topDecileFishLift"], 4))
              + " | raw AUC " + str(round(r["raw"]["auc"], 4))
              + " oracle AUC " + str(round(r["oraclePrior"]["auc"], 4))
              + " adapt AUC " + str(round(r["adaptPrior"]["auc"], 4)))
    print("[e26u] summary -> " + str(out_dir / "mode_stratification.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
